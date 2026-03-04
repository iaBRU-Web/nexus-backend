// api/login/index.go
// BUG FIX #3: moved to own directory (api/login/) so it has its own package scope
// BUG FIX #4: removed unused "bytes" import and var _ = bytes.Compare hack
// LANGUAGE: Go | Compiled by Vercel automatically

package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

var loginUsernameRe = regexp.MustCompile(`^[a-zA-Z0-9_]{3,32}$`)

func loginHashPassword(password, appSalt string) []byte {
	combined := appSalt + password + appSalt
	hash := sha256.Sum256([]byte(combined))
	for i := 0; i < 10000; i++ {
		h := sha256.New()
		h.Write(hash[:])
		h.Write([]byte(password))
		copy(hash[:], h.Sum(nil))
	}
	hexChars := "0123456789abcdef"
	result := make([]byte, 64)
	for i, b := range hash {
		result[i*2]   = hexChars[b>>4]
		result[i*2+1] = hexChars[b&0xf]
	}
	return result
}

func loginCreateToken(username, displayName, secret string) string {
	payload := fmt.Sprintf(`{"username":"%s","displayName":"%s","iat":%d}`,
		username, displayName, time.Now().Unix())
	data := base64.RawURLEncoding.EncodeToString([]byte(payload))
	mac  := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(data))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return data + "." + sig
}

type loginGHFile struct {
	Content string `json:"content"`
	SHA     string `json:"sha"`
}

type loginUsersDB map[string]struct {
	Username     string `json:"username"`
	DisplayName  string `json:"displayName"`
	PasswordHash string `json:"passwordHash"`
}

func loginReadUsers(ghToken, ghRepo string) (loginUsersDB, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/contents/users.json", ghRepo)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Authorization", "token "+ghToken)
	req.Header.Set("Accept", "application/vnd.github.v3+json")
	req.Header.Set("User-Agent", "nexus-backend")

	resp, err := http.DefaultClient.Do(req)
	if err != nil { return nil, err }
	defer resp.Body.Close()

	if resp.StatusCode == 404 { return loginUsersDB{}, nil }

	var f loginGHFile
	json.NewDecoder(resp.Body).Decode(&f)

	// Strip newlines GitHub inserts into base64
	cleaned := strings.ReplaceAll(f.Content, "\n", "")
	decoded, err := base64.StdEncoding.DecodeString(cleaned)
	if err != nil { return nil, err }

	var users loginUsersDB
	json.Unmarshal(decoded, &users)
	return users, nil
}

func loginJSON(w http.ResponseWriter, status int, body interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func Handler(w http.ResponseWriter, r *http.Request) {
	if r.Method == "OPTIONS" {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.WriteHeader(204)
		return
	}
	if r.Method != "POST" {
		loginJSON(w, 405, map[string]string{"error": "Method not allowed"})
		return
	}

	ghToken := os.Getenv("GITHUB_DB_TOKEN")
	ghRepo  := os.Getenv("GITHUB_DB_REPO")
	secret  := os.Getenv("TOKEN_SECRET")
	appSalt := os.Getenv("PASSWORD_SALT")
	if appSalt == "" { appSalt = "nexus_default_salt_change_in_vercel" }

	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		loginJSON(w, 400, map[string]string{"error": "Invalid request body"})
		return
	}
	if !loginUsernameRe.MatchString(body.Username) {
		loginJSON(w, 400, map[string]string{"error": "Invalid username format"})
		return
	}
	if len(body.Password) == 0 {
		loginJSON(w, 400, map[string]string{"error": "Password is required"})
		return
	}

	uKey  := strings.ToLower(body.Username)
	users, err := loginReadUsers(ghToken, ghRepo)
	if err != nil {
		loginJSON(w, 500, map[string]string{"error": "Database read failed"})
		return
	}

	user, exists := users[uKey]

	// Always hash regardless — prevents timing attack on user enumeration
	computed    := loginHashPassword(body.Password, appSalt)
	storedBytes := []byte(user.PasswordHash)

	if !exists || !hmac.Equal(computed, storedBytes) {
		loginJSON(w, 401, map[string]string{"error": "Invalid username or password"})
		return
	}

	dn := user.DisplayName
	if dn == "" { dn = uKey }

	token := loginCreateToken(uKey, dn, secret)
	loginJSON(w, 200, map[string]string{
		"token":       token,
		"username":    uKey,
		"displayName": dn,
	})
}

// api/signup/index.go
// BUG FIX #3: own directory = own package scope, no func Handler collision
// LANGUAGE: Go | Compiled by Vercel automatically

package handler

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

var signupUsernameRe = regexp.MustCompile(`^[a-zA-Z0-9_]{3,32}$`)

func signupHashPassword(password, appSalt string) string {
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
	return string(result)
}

func signupCreateToken(username, displayName, secret string) string {
	payload := fmt.Sprintf(`{"username":"%s","displayName":"%s","iat":%d}`,
		username, displayName, time.Now().Unix())
	data := base64.RawURLEncoding.EncodeToString([]byte(payload))
	mac  := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(data))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return data + "." + sig
}

type signupGHFile struct {
	Content string `json:"content"`
	SHA     string `json:"sha"`
	Message string `json:"message"`
}

type signupUsersMap map[string]signupUserRecord

type signupUserRecord struct {
	Username     string `json:"username"`
	DisplayName  string `json:"displayName"`
	PasswordHash string `json:"passwordHash"`
	CreatedAt    string `json:"createdAt"`
}

func signupGHHeaders(token string) map[string]string {
	return map[string]string{
		"Authorization": "token " + token,
		"Accept":        "application/vnd.github.v3+json",
		"Content-Type":  "application/json",
		"User-Agent":    "nexus-backend",
	}
}

func signupReadUsers(ghToken, ghRepo string) (signupUsersMap, string, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/contents/users.json", ghRepo)
	req, _ := http.NewRequest("GET", url, nil)
	for k, v := range signupGHHeaders(ghToken) { req.Header.Set(k, v) }

	resp, err := http.DefaultClient.Do(req)
	if err != nil { return signupUsersMap{}, "", err }
	defer resp.Body.Close()

	if resp.StatusCode == 404 { return signupUsersMap{}, "", nil }

	var f signupGHFile
	json.NewDecoder(resp.Body).Decode(&f)
	cleaned := strings.ReplaceAll(f.Content, "\n", "")
	decoded, err := base64.StdEncoding.DecodeString(cleaned)
	if err != nil { return signupUsersMap{}, "", err }

	var users signupUsersMap
	if err := json.Unmarshal(decoded, &users); err != nil { return signupUsersMap{}, "", err }
	return users, f.SHA, nil
}

func signupWriteUsers(ghToken, ghRepo string, users signupUsersMap, sha string) error {
	url := fmt.Sprintf("https://api.github.com/repos/%s/contents/users.json", ghRepo)
	content, _ := json.MarshalIndent(users, "", "  ")
	encoded := base64.StdEncoding.EncodeToString(content)
	bodyMap := map[string]interface{}{"message": "nexus: update users", "content": encoded}
	if sha != "" { bodyMap["sha"] = sha }

	bodyBytes, _ := json.Marshal(bodyMap)
	req, _ := http.NewRequest("PUT", url, bytes.NewReader(bodyBytes))
	for k, v := range signupGHHeaders(ghToken) { req.Header.Set(k, v) }

	resp, err := http.DefaultClient.Do(req)
	if err != nil { return err }
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("github write failed %d: %s", resp.StatusCode, string(b))
	}
	return nil
}

func signupJSON(w http.ResponseWriter, status int, body interface{}) {
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
		signupJSON(w, 405, map[string]string{"error": "Method not allowed"})
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
		signupJSON(w, 400, map[string]string{"error": "Invalid request body"})
		return
	}
	if !signupUsernameRe.MatchString(body.Username) {
		signupJSON(w, 400, map[string]string{"error": "Username: 3–32 chars, letters/numbers/underscore only"})
		return
	}
	if len(body.Password) < 6 {
		signupJSON(w, 400, map[string]string{"error": "Password must be at least 6 characters"})
		return
	}
	if len(body.Password) > 72 {
		signupJSON(w, 400, map[string]string{"error": "Password too long (max 72 chars)"})
		return
	}

	uKey := strings.ToLower(body.Username)
	users, sha, err := signupReadUsers(ghToken, ghRepo)
	if err != nil {
		signupJSON(w, 500, map[string]string{"error": "Database read failed"})
		return
	}
	if _, exists := users[uKey]; exists {
		signupJSON(w, 409, map[string]string{"error": "Username already taken"})
		return
	}

	users[uKey] = signupUserRecord{
		Username:     uKey,
		DisplayName:  body.Username,
		PasswordHash: signupHashPassword(body.Password, appSalt),
		CreatedAt:    time.Now().UTC().Format(time.RFC3339),
	}
	if err := signupWriteUsers(ghToken, ghRepo, users, sha); err != nil {
		signupJSON(w, 500, map[string]string{"error": "Database write failed"})
		return
	}

	token := signupCreateToken(uKey, body.Username, secret)
	signupJSON(w, 201, map[string]string{
		"token":       token,
		"username":    uKey,
		"displayName": body.Username,
	})
}

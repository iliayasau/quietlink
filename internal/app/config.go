package app

import (
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"strings"
)

type ICE struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type Config struct {
	Origin, Issuer, ClientID, ClientSecret, Listen, Static string
	Development                                            bool
	ICE                                                    []ICE
}

func LoadConfig() (Config, error) {
	c := Config{Origin: os.Getenv("APP_ORIGIN"), Issuer: os.Getenv("OIDC_ISSUER"), ClientID: os.Getenv("OIDC_CLIENT_ID"), ClientSecret: os.Getenv("OIDC_CLIENT_SECRET"), Listen: os.Getenv("LISTEN_ADDR"), Static: "web/dist", Development: os.Getenv("APP_ENV") == "development"}
	if c.Listen == "" {
		c.Listen = "127.0.0.1:8080"
	}
	if value := os.Getenv("ICE_SERVERS"); value != "" {
		if err := json.Unmarshal([]byte(value), &c.ICE); err != nil {
			return c, errors.New("ICE_SERVERS must be a JSON array")
		}
	}
	return c, c.Validate()
}

func loopback(host string) bool { return host == "localhost" || host == "127.0.0.1" || host == "::1" }

func (c Config) Validate() error {
	for _, raw := range []string{c.Origin, c.Issuer} {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return errors.New("valid APP_ORIGIN and OIDC_ISSUER are required")
		}
		if u.Scheme != "https" && !(c.Development && u.Scheme == "http" && loopback(u.Hostname())) {
			return errors.New("HTTPS required; HTTP allowed only on loopback in development")
		}
	}
	u, _ := url.Parse(c.Origin)
	if u.Path != "" || strings.HasSuffix(c.Origin, "/") {
		return errors.New("APP_ORIGIN must contain only scheme and host, without trailing slash")
	}
	if c.ClientID == "" {
		return errors.New("OIDC_CLIENT_ID required")
	}
	if !c.Development && c.ClientID == "quietlink-local" {
		return errors.New("local fixture client forbidden in production")
	}
	for _, ice := range c.ICE {
		if len(ice.URLs) == 0 {
			return errors.New("ICE server URLs required")
		}
		for _, raw := range ice.URLs {
			if !strings.HasPrefix(raw, "stun:") && !strings.HasPrefix(raw, "turn:") && !strings.HasPrefix(raw, "turns:") {
				return errors.New("ICE URL must use stun, turn or turns")
			}
		}
	}
	return nil
}

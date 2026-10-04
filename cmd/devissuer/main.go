package main

import (
	"github.com/iliayasau/quietlink/internal/devissuer"
	"log"
	"net/http"
	"os"
	"time"
)

func main() {
	if os.Getenv("APP_ENV") != "development" {
		log.Fatal("The test identity provider requires APP_ENV=development")
	}
	i, err := devissuer.New("http://127.0.0.1:9090", "http://127.0.0.1:8080/auth/callback")
	if err != nil {
		log.Fatal(err)
	}
	s := http.Server{Addr: "127.0.0.1:9090", Handler: i.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16384}
	log.Print("Local test identities on 127.0.0.1:9090; not for production")
	log.Fatal(s.ListenAndServe())
}

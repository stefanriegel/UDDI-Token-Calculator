package server

import (
	"io/fs"
	"net/http"
)

// NewStaticHandler returns an http.Handler that serves the embedded frontend/dist/ files.
// staticFiles is the embed.FS declared in the root embed.go (package main).
// fs.Sub strips the "frontend/dist" prefix so files are served at "/" not "/frontend/dist/".
//
// No SPA fallback handler is needed: the frontend has no client-side routing.
// http.FileServer handles / → index.html and /assets/* → hashed JS/CSS files correctly.
func NewStaticHandler(staticFiles fs.FS) (http.Handler, error) {
	sub, err := fs.Sub(staticFiles, "frontend/dist")
	if err != nil {
		return nil, err
	}
	return http.FileServer(http.FS(sub)), nil
}

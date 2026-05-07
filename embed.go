package main

import "embed"

//go:embed all:frontend/dist
var staticFiles embed.FS

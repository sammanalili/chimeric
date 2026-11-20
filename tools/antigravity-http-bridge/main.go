// agy-http-bridge — a transport shim that presents the exact same TLS/HTTP2
// ClientHello as the official Antigravity CLI (Go net/http + crypto/tls).
//
// Protocol (NDJSON over stdin/stdout):
//
//	in  : {"id":"...","url":"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
//	       "token":"ya29...","body":"<json string>"}
//	out : {"id":"...","status":200,"headers":{...}}      (once, first)
//	      {"id":"...","data":"<base64 bytes>"}           (repeated, in order)
//	      {"id":"...","done":true}                       (terminal, success)
//	      {"id":"...","error":"..."}                     (terminal, failure)
//
// The process is long-lived; requests are multiplexed by id. The caller decides
// timeouts and cancellation (by killing the process or closing stdin).
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"
)

const userAgent = "antigravity/cli/1.5.5 (aidev_client; os_type=darwin; arch=arm64; cl=1017970541; auth_method=consumer)"

type request struct {
	ID     string `json:"id"`
	URL    string `json:"url"`
	Token  string `json:"token"`
	Body   string `json:"body"`
	Cancel bool   `json:"cancel,omitempty"`
}

// active requests by id, so a cancel line can abort an in-flight body.
var active sync.Map

type outMsg struct {
	ID      string            `json:"id"`
	Status  *int              `json:"status,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Data    string            `json:"data,omitempty"`
	Done    bool              `json:"done,omitempty"`
	Error   string            `json:"error,omitempty"`
}

var (
	out   = bufio.NewWriterSize(os.Stdout, 1<<16)
	outMu sync.Mutex
)

func emit(msg outMsg) {
	outMu.Lock()
	defer outMu.Unlock()
	line, err := json.Marshal(msg)
	if err != nil {
		return
	}
	out.Write(line)
	out.WriteByte('\n')
	out.Flush()
}

type chunkWriter struct{ id string }

func (w chunkWriter) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	emit(outMsg{ID: w.id, Data: base64.StdEncoding.EncodeToString(p)})
	return len(p), nil
}

func dispatch(client *http.Client, req request) {
	if req.ID == "" {
		emit(outMsg{Error: "id is required"})
		return
	}
	if req.Cancel {
		if cancel, ok := active.Load(req.ID); ok {
			cancel.(context.CancelFunc)()
		}
		return
	}
	if req.URL == "" {
		emit(outMsg{ID: req.ID, Error: "url is required"})
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	// Register before spawning so the next stdin line can cancel immediately.
	active.Store(req.ID, cancel)
	go handle(client, req, ctx, cancel)
}

func handle(client *http.Client, req request, ctx context.Context, cancel context.CancelFunc) {
	defer cancel()
	defer active.Delete(req.ID)

	httpReq, err := http.NewRequestWithContext(ctx, "POST", req.URL, bytes.NewReader([]byte(req.Body)))
	if err != nil {
		emit(outMsg{ID: req.ID, Error: "invalid request: " + err.Error()})
		return
	}
	// Header set matches the official client exactly (captured traffic shows
	// no Accept header on generate calls; Go adds Host/Content-Length/
	// Accept-Encoding: gzip itself, as the official client does).
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+req.Token)
	httpReq.Header.Set("User-Agent", userAgent)

	resp, err := client.Do(httpReq)
	if err != nil {
		emit(outMsg{ID: req.ID, Error: "transport: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	headers := map[string]string{}
	for _, name := range []string{"content-type", "retry-after", "x-request-id"} {
		if value := resp.Header.Get(name); value != "" {
			headers[name] = value
		}
	}
	status := resp.StatusCode
	emit(outMsg{ID: req.ID, Status: &status, Headers: headers})

	if _, err := io.Copy(chunkWriter{req.ID}, resp.Body); err != nil {
		emit(outMsg{ID: req.ID, Error: "read: " + err.Error()})
		return
	}
	emit(outMsg{ID: req.ID, Done: true})
}

func main() {
	client := &http.Client{
		Transport: &http.Transport{
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          8,
			MaxIdleConnsPerHost:   8,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   15 * time.Second,
			ExpectContinueTimeout: time.Second,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}

	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println("agy-http-bridge 1")
		return
	}

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1<<20), 64<<20)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			emit(outMsg{Error: "bad line: " + err.Error()})
			continue
		}
		dispatch(client, req)
	}
	// stdin closed: let in-flight bodies finish writing, then exit.
	time.Sleep(50 * time.Millisecond)
}

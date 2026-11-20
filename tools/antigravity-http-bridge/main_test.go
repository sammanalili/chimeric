package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCancelEnvelopeWithoutURLStopsAnActiveRequest(t *testing.T) {
	started := make(chan struct{})
	stopped := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
		close(stopped)
	}))
	defer server.Close()
	dispatch(server.Client(), request{ID: "synthetic-cancel-after-headers", URL: server.URL, Token: "synthetic-access", Body: "{}"})
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("the local HTTP request never started")
	}
	// This is the exact envelope sent by BridgeProcess after response headers.
	dispatch(server.Client(), request{ID: "synthetic-cancel-after-headers", Cancel: true})
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("the cancel envelope did not cancel the remote HTTP request")
	}
}

func TestImmediateCancelIsRegisteredBeforeWorkerStarts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()
	const id = "synthetic-immediate-cancel"
	dispatch(server.Client(), request{ID: id, URL: server.URL, Token: "synthetic-access", Body: "{}"})
	dispatch(server.Client(), request{ID: id, Cancel: true})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, present := active.Load(id); !present {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("an immediate cancel left the request active")
}

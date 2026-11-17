package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-contrib/sessions"
	"github.com/gin-contrib/sessions/cookie"
	"github.com/gin-gonic/gin"
)

func namesOnlyRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(sessions.Sessions("session", cookie.NewStore([]byte("test-secret-test-secret-test-secret"))))
	InitEvents(r.Group("/api"))
	return r
}

func TestNamesOnlyRoutesRegistered(t *testing.T) {
	registered := map[string]bool{}
	for _, route := range namesOnlyRouter().Routes() {
		registered[route.Method+" "+route.Path] = true
	}

	for _, want := range []string{
		"POST /api/events",
		"PUT /api/events/:eventId",
		"GET /api/events/:eventId",
		"GET /api/events/:eventId/responses",
		"POST /api/events/:eventId/response",
		"DELETE /api/events/:eventId/response",
		"POST /api/events/:eventId/rename-user",
	} {
		if !registered[want] {
			t.Errorf("expected route %s to be registered", want)
		}
	}
	for _, gone := range []string{
		"POST /api/events/import",
		"POST /api/events/:eventId/responded",
		"POST /api/events/:eventId/decline",
		"GET /api/events/:eventId/calendar-availabilities",
		"DELETE /api/events/:eventId",
		"POST /api/events/:eventId/duplicate",
		"POST /api/events/:eventId/archive",
	} {
		if registered[gone] {
			t.Errorf("route %s needs an account and should not be registered", gone)
		}
	}
}

func TestCreateGroupRejected(t *testing.T) {
	body := `{"name":"g","duration":1,"dates":["2026-01-01T00:00:00Z"],"type":"group"}`
	req := httptest.NewRequest(http.MethodPost, "/api/events", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	namesOnlyRouter().ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "groups-disabled") {
		t.Fatalf("got %d %s, want 400 groups-disabled", w.Code, w.Body.String())
	}
}

package control

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

// The control-plane identity supplies the reachable origin, including a reverse-proxy prefix.
// Never forward Runner credentials or case-specific query parameters into the test process.
var debugAccessKeyPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func ddtInsightURL(controlPlaneURL *url.URL, scope DdtScope) (string, error) {
	if controlPlaneURL == nil || (controlPlaneURL.Scheme != "http" && controlPlaneURL.Scheme != "https") || controlPlaneURL.Host == "" || controlPlaneURL.User != nil || controlPlaneURL.RawQuery != "" || controlPlaneURL.Fragment != "" {
		return "", errors.New("DDT API requires an HTTP(S) control-plane URL without credentials, query or fragment")
	}
	for _, identifier := range []string{scope.ProjectID, scope.ProjectVersionID, scope.TestStageID} {
		if identifier == "" || !utf8.ValidString(identifier) || utf8.RuneCountInString(identifier) > 128 || strings.ContainsAny(identifier, "\x00\r\n") || identifier == "." || identifier == ".." {
			return "", errors.New("DDT API scope must contain valid project, version and stage identifiers")
		}
	}
	suffix := "/case"
	if scope.Debug != nil {
		owner := scope.Debug.OwnerUserID
		if owner == "" || owner == "." || owner == ".." || !utf8.ValidString(owner) || utf8.RuneCountInString(owner) > 128 || strings.ContainsAny(owner, "\x00\r\n") || !debugAccessKeyPattern.MatchString(scope.Debug.AccessKey) {
			return "", errors.New("personal DDT API requires a valid owner and read access key")
		}
		suffix = "/users/" + url.PathEscape(owner) + "/debug/" + url.PathEscape(scope.Debug.AccessKey) + "/case"
	}
	return strings.TrimRight(controlPlaneURL.String(), "/") + "/api/v1/public/ddt/projects/" + url.PathEscape(scope.ProjectID) +
		"/versions/" + url.PathEscape(scope.ProjectVersionID) + "/stages/" + url.PathEscape(scope.TestStageID) + suffix, nil
}

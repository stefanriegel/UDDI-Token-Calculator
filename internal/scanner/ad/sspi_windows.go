//go:build windows && cgo

package ad

/*
#cgo LDFLAGS: -lsecur32

#include <windows.h>
#define SECURITY_WIN32
#include <sspi.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct {
    void*  token;
    unsigned long tokenLen;
    int    ok;
    char   errMsg[256];
} SSPIResult;

SSPIResult acquireSSPINegotiateToken(const char* targetSPN) {
    SSPIResult result = {0};

    CredHandle credHandle;
    TimeStamp  expiry;

    SECURITY_STATUS sc = AcquireCredentialsHandleA(
        NULL,           // current logged-on user
        "Negotiate",    // SPNEGO (Kerberos preferred, NTLM fallback)
        SECPKG_CRED_OUTBOUND,
        NULL,           // current user LUID
        NULL,           // no auth data — use current session
        NULL, NULL,
        &credHandle, &expiry
    );
    if (sc != SEC_E_OK) {
        snprintf(result.errMsg, sizeof(result.errMsg),
                 "AcquireCredentialsHandle failed: 0x%08lx", (unsigned long)sc);
        return result;
    }

    // Allocate output buffer for the security token.
    BYTE tokenBuf[8192];
    SecBuffer     outBuf  = { sizeof(tokenBuf), SECBUFFER_TOKEN, tokenBuf };
    SecBufferDesc outDesc = { SECBUFFER_VERSION, 1, &outBuf };

    CtxtHandle ctxHandle;
    ULONG      attrs = 0;
    sc = InitializeSecurityContextA(
        &credHandle,
        NULL,                   // no prior context (first call)
        (SEC_CHAR*)targetSPN,   // SPN: e.g. "WSMAN/dc01.corp.local"
        ISC_REQ_ALLOCATE_MEMORY | ISC_REQ_CONFIDENTIALITY | ISC_REQ_SEQUENCE_DETECT |
        ISC_REQ_REPLAY_DETECT,
        0, SECURITY_NATIVE_DREP,
        NULL,                   // no input token (first call)
        0,
        &ctxHandle, &outDesc,
        &attrs, &expiry
    );
    FreeCredentialsHandle(&credHandle);

    if (sc != SEC_E_OK && sc != SEC_I_CONTINUE_NEEDED) {
        snprintf(result.errMsg, sizeof(result.errMsg),
                 "InitializeSecurityContext failed: 0x%08lx", (unsigned long)sc);
        DeleteSecurityContext(&ctxHandle);
        return result;
    }

    // Copy the token out.
    result.tokenLen = outBuf.cbBuffer;
    result.token    = malloc(outBuf.cbBuffer);
    if (result.token) {
        memcpy(result.token, outBuf.pvBuffer, outBuf.cbBuffer);
        result.ok = 1;
    } else {
        snprintf(result.errMsg, sizeof(result.errMsg), "malloc failed");
    }

    if (sc == SEC_I_CONTINUE_NEEDED) {
        // Multi-leg: we only need the first token for WinRM Negotiate initiation.
        // winrm library handles the continuation internally.
        result.ok = 1;
    }

    DeleteSecurityContext(&ctxHandle);
    return result;
}
*/
import "C"
import (
	"fmt"
	"unsafe"
)

// ErrSSPINotAvailable is never returned on Windows builds.
var ErrSSPINotAvailable error = nil

// AcquireSSPINegotiateToken obtains a SPNEGO Negotiate token for the given
// WinRM target using the currently logged-on Windows user's credentials.
// targetSPN should be "WSMAN/<hostname>" — e.g. "WSMAN/dc01.corp.local".
//
// The returned token is the raw SPNEGO/Negotiate blob to be used as the
// Authorization header value in the WinRM HTTP request. The WinRM library
// handles the HTTP-level Negotiate exchange; this function only produces the
// first-leg token.
func AcquireSSPINegotiateToken(targetSPN string) ([]byte, error) {
	cSPN := C.CString(targetSPN)
	defer C.free(unsafe.Pointer(cSPN))

	res := C.acquireSSPINegotiateToken(cSPN)
	if res.ok == 0 {
		return nil, fmt.Errorf("SSPI: %s", C.GoString(&res.errMsg[0]))
	}
	defer C.free(res.token)

	token := C.GoBytes(res.token, C.int(res.tokenLen))
	return token, nil
}

// BuildSSPIClient constructs a WinRM client that uses Windows SSPI (Negotiate/
// Kerberos) for authentication. The currently logged-on Windows domain user's
// credentials are used — no username or password required.
//
// This only works on a domain-joined Windows host. On Linux/macOS this function
// is replaced by a stub in sspi_stub.go that returns ErrSSPINotAvailable.
func BuildSSPIClient(host string, opts ...ClientOption) (*SSPIWinRMClient, error) {
	token, err := AcquireSSPINegotiateToken("WSMAN/" + host)
	if err != nil {
		return nil, fmt.Errorf("SSPI token acquisition failed: %w", err)
	}
	return &SSPIWinRMClient{host: host, token: token, opts: opts}, nil
}

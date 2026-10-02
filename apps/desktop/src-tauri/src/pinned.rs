//! The pinned fetch (ADR 0006, amended for phones; `Platform.pinnedFetch` in
//! src/platform/tauri.ts). A phone pairs with a Sidecar's LAN address, which
//! serves a self-signed certificate; the Pairing invite carries that
//! certificate's fingerprint (SHA-256 of its DER, base64url without padding).
//! A webview cannot pin a certificate, so every request to such an address
//! goes through this command: it accepts exactly the certificate whose
//! fingerprint was pinned, whatever name or issuer it has, and no other. A
//! different certificate fails with an error that starts with `PinMismatch`,
//! which the webview turns into an Error of that name.
//!
//! Bodies are buffered and travel base64 both ways.

// Only a phone registers the command; a computer builds this for its tests.
#![cfg_attr(desktop, allow(dead_code))]

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// What the error message starts with when the certificate is not the pinned one.
pub const PIN_MISMATCH: &str = "PinMismatch";

/// SHA-256 of a certificate's DER, base64url without padding: what a phone pins.
pub fn fingerprint_of(der: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(der))
}

/// Accepts the one certificate whose fingerprint is `pin`; signatures are still checked.
#[derive(Debug)]
pub struct PinVerifier {
    pin: String,
    provider: Arc<CryptoProvider>,
}

impl PinVerifier {
    pub fn new(pin: &str) -> Self {
        PinVerifier {
            pin: pin.trim().trim_end_matches('=').to_string(),
            provider: Arc::new(rustls::crypto::ring::default_provider()),
        }
    }
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if fingerprint_of(end_entity.as_ref()) == self.pin {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(PIN_MISMATCH.to_string()))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// One HTTP client per pinned certificate, kept for its connections.
fn client(pin: &str) -> Result<reqwest::Client, String> {
    static CLIENTS: OnceLock<Mutex<HashMap<String, reqwest::Client>>> = OnceLock::new();
    let mut clients = CLIENTS.get_or_init(Default::default).lock().map_err(|e| e.to_string())?;
    if let Some(c) = clients.get(pin) {
        return Ok(c.clone());
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinVerifier::new(pin)))
        .with_no_client_auth();
    let c = reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .build()
        .map_err(|e| e.to_string())?;
    clients.insert(pin.to_string(), c.clone());
    Ok(c)
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PinnedRequest {
    pub fingerprint: String,
    pub url: String,
    #[serde(default = "get")]
    pub method: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// Base64; none for a request without a body.
    #[serde(default)]
    pub body: Option<String>,
}

fn get() -> String {
    "GET".to_string()
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PinnedResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    /// Base64.
    pub body: String,
}

/// Names the failure: a certificate that is not the pinned one, or anything else.
fn describe(error: &reqwest::Error) -> String {
    if format!("{error:?}").contains(PIN_MISMATCH) {
        format!("{PIN_MISMATCH}: the certificate is not the one this phone pinned")
    } else {
        let mut text = error.to_string();
        let mut source = std::error::Error::source(error);
        while let Some(s) = source {
            text.push_str(": ");
            text.push_str(&s.to_string());
            source = s.source();
        }
        text
    }
}

#[tauri::command]
pub async fn pinned_fetch(request: PinnedRequest) -> Result<PinnedResponse, String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let method = reqwest::Method::from_bytes(request.method.to_ascii_uppercase().as_bytes())
        .map_err(|e| e.to_string())?;
    let mut builder = client(&request.fingerprint)?.request(method, &request.url);
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = &request.body {
        builder = builder.body(b64.decode(body).map_err(|e| e.to_string())?);
    }
    let res = builder.send().await.map_err(|e| describe(&e))?;
    let status = res.status();
    let headers = res
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect();
    let bytes = res.bytes().await.map_err(|e| describe(&e))?;
    Ok(PinnedResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        body: b64.encode(bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(verifier: &PinVerifier, der: &[u8]) -> Result<ServerCertVerified, rustls::Error> {
        verifier.verify_server_cert(
            &CertificateDer::from(der.to_vec()),
            &[],
            &ServerName::try_from("192.168.1.20").unwrap(),
            &[],
            UnixTime::now(),
        )
    }

    #[test]
    fn the_fingerprint_is_sha256_base64url_without_padding() {
        // SHA-256 of "abc", as the server's self-signed.ts computes it.
        assert_eq!(fingerprint_of(b"abc"), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    }

    #[test]
    fn only_the_pinned_certificate_passes() {
        let pin = fingerprint_of(b"the server's certificate");
        let verifier = PinVerifier::new(&format!("{pin}="));
        assert!(check(&verifier, b"the server's certificate").is_ok());
        let err = check(&verifier, b"someone else's certificate").unwrap_err();
        assert!(err.to_string().contains(PIN_MISMATCH));
    }

    #[test]
    fn a_request_reads_from_the_webview_shape() {
        let r: PinnedRequest = serde_json::from_str(
            r#"{"fingerprint":"x","url":"https://192.168.1.20:47820/health","headers":[["authorization","Bearer t"]]}"#,
        )
        .unwrap();
        assert_eq!(r.method, "GET");
        assert_eq!(r.headers, vec![("authorization".to_string(), "Bearer t".to_string())]);
        assert!(r.body.is_none());
    }
}

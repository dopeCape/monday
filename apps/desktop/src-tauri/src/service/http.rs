//! A minimal HTTP/1.1 client for the Sidecar on loopback: the app's probes
//! and commands (GET /service, POST /unlock, POST /service/stop) before the
//! webview is up. One request per connection, `Connection: close`, bearer
//! token, JSON bodies; chunked answers are decoded. Loopback only, so no TLS.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

#[derive(Debug, PartialEq)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

pub fn request(
    port: u16,
    method: &str,
    path: &str,
    token: &str,
    body: Option<&str>,
    timeout: Duration,
) -> Result<Response, String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    let body = body.unwrap_or("");
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(head.as_bytes())
        .map_err(|e| e.to_string())?;
    stream
        .write_all(body.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    parse_response(&raw)
}

/// Splits a raw answer into its status and body, decoding a chunked body.
pub fn parse_response(raw: &[u8]) -> Result<Response, String> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "no end of headers".to_string())?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let rest = &raw[split + 4..];
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| "no status line".to_string())?;
    let chunked = lines.any(|l| {
        let lower = l.to_ascii_lowercase();
        lower.starts_with("transfer-encoding:") && lower.contains("chunked")
    });
    let body = if chunked {
        dechunk(rest)?
    } else {
        rest.to_vec()
    };
    Ok(Response {
        status,
        body: String::from_utf8_lossy(&body).to_string(),
    })
}

fn dechunk(mut data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let eol = data
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or_else(|| "bad chunk".to_string())?;
        let size_text = String::from_utf8_lossy(&data[..eol]).to_string();
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| "bad chunk size".to_string())?;
        data = &data[eol + 2..];
        if size == 0 {
            return Ok(out);
        }
        if data.len() < size {
            return Err("short chunk".to_string());
        }
        out.extend_from_slice(&data[..size]);
        data = data.get(size + 2..).unwrap_or(&[]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn plain_and_chunked_answers() {
        let plain = b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
        assert_eq!(
            parse_response(plain).unwrap(),
            Response {
                status: 200,
                body: "{\"ok\":true}".into()
            }
        );
        let chunked =
            b"HTTP/1.1 202 Accepted\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\n\r\n";
        assert_eq!(
            parse_response(chunked).unwrap(),
            Response {
                status: 202,
                body: "{\"a\":1}".into()
            }
        );
        assert!(parse_response(b"garbage").is_err());
    }

    #[test]
    fn a_request_carries_the_token_and_the_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let mut got = Vec::new();
            // Headers and the 2-byte body arrive; read until both are in.
            while !String::from_utf8_lossy(&got).ends_with("{}") {
                let n = conn.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                got.extend_from_slice(&buf[..n]);
            }
            conn.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\n\r\nno")
                .unwrap();
            String::from_utf8_lossy(&got).to_string()
        });
        let res = request(
            port,
            "POST",
            "/unlock",
            "tok",
            Some("{}"),
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(
            res,
            Response {
                status: 401,
                body: "no".into()
            }
        );
        let seen = server.join().unwrap();
        assert!(seen.starts_with("POST /unlock HTTP/1.1\r\n"));
        assert!(seen.contains("Authorization: Bearer tok\r\n"));
        assert!(seen.contains("Content-Length: 2\r\n"));
    }

    #[test]
    fn nothing_listening_is_an_error_not_a_hang() {
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        assert!(request(port, "GET", "/service", "t", None, Duration::from_secs(2)).is_err());
    }
}

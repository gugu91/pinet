# Test fixtures

`tls-test-key.pem` / `tls-test-cert.pem` are a **test-only** self-signed
EC keypair and certificate (CN=localhost, SAN localhost/127.0.0.1) used by the
TLS transport tests. They protect nothing, are intentionally committed, and
must never be used outside the test suite.

Regenerate with:

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout tls-test-key.pem -out tls-test-cert.pem -days 36500 -nodes \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

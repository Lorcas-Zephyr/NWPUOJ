# HTTPS deployment

Production traffic must terminate TLS at a reverse proxy. The SYZOJ container
must only listen on loopback so users cannot bypass the proxy.

1. Copy the values from `https.env.example` into the repository root `.env` and
   replace `oj.example.edu` with the canonical site hostname.
2. Replace the hostname and certificate paths in `nginx-https.conf.example`,
   then install it in Nginx's `conf.d` directory.
3. Run `docker compose up -d` and verify that the published web address is
   `127.0.0.1:8080->80` with `docker compose ps`.
4. Run `nginx -t`, reload Nginx, and verify that HTTP redirects to HTTPS.

The example requires Nginx 1.19.3 or newer because it uses
`proxy_cookie_flags`. The proxy overwrites all forwarded host and protocol
headers, which is required for trusted reset links and same-origin checks.

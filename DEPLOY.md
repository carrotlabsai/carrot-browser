# Deploying Carrot Browser Bridge

Carrot includes a Dockerfile for running the bridge server anywhere. The
community-hosted bridge at `https://browser.carrotlabs.ai` is one instance of
the same open-source `server.py` that you can run yourself.

## Docker

Build and run the bridge locally:

```bash
docker build -t carrot-browser-bridge .
docker run --rm -p 8080:8080 carrot-browser-bridge
```

Then open the extension options and set the server URL to:

```text
http://127.0.0.1:8080
```

## Fly.io

An example Fly config is available at `deploy/fly.example.toml`.

To deploy your own bridge:

```bash
cp deploy/fly.example.toml fly.toml
# Edit the app name in fly.toml.
fly launch --no-deploy
fly deploy
```

The Carrot Labs Fly app config for `https://browser.carrotlabs.ai` is
intentionally not committed here, so other operators do not accidentally deploy
to or depend on that hosted `carrot-bridge` app.

## Notes

The bridge keeps browser connections, pairing codes, sessions, and in-flight
commands in memory. Run a single instance unless you add shared state and
cross-instance routing.

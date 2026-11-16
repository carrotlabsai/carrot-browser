import logging
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest
import uvicorn
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

TOKEN = "tok_" + "s3cr3t" * 4


def test_redact_secrets_replaces_secret_query_values():
    path = f"/ws?browser_id=abc&browser_token={TOKEN}&x=1"
    assert server.redact_secrets(path) == "/ws?browser_id=abc&browser_token=[REDACTED]&x=1"
    assert server.redact_secrets(f"/cb?TOKEN={TOKEN}") == "/cb?TOKEN=[REDACTED]"
    assert server.redact_secrets(f"/x?session_token={TOKEN}#frag") == "/x?session_token=[REDACTED]#frag"
    assert server.redact_secrets(f'"GET /x?api_key={TOKEN} HTTP/1.1"') == '"GET /x?api_key=[REDACTED] HTTP/1.1"'
    assert server.redact_secrets(f"secret='{TOKEN}' key=\"{TOKEN}\" x=1") == "secret=[REDACTED] key=[REDACTED] x=1"
    assert server.redact_secrets("/ws?browser_id=abc&tokens=1") == "/ws?browser_id=abc&tokens=1"


def test_log_records_are_redacted_for_any_logger(caplog):
    caplog.set_level(logging.INFO)
    access = logging.getLogger("uvicorn.access")
    access.info('%s - "%s %s HTTP/%s" %d', "1.2.3.4:5", "GET", f"/ws?browser_token={TOKEN}", "1.1", 101)
    logging.getLogger("carrot.test").warning(f"connect /ws?browser_token={TOKEN}")
    logging.getLogger("carrot.test").info("%(url)s", {"url": f"/ws?browser_token={TOKEN}"})
    logging.getLogger("carrot.test").info("GET %s %d", httpx.URL(f"https://x/ws?browser_token={TOKEN}"), 101)
    assert TOKEN not in caplog.text
    assert caplog.text.count("browser_token=[REDACTED]") == 4
    assert caplog.records[0].args[2] == "/ws?browser_token=[REDACTED]"


def test_access_log_keeps_its_args_for_quoted_query_values(caplog):
    caplog.set_level(logging.INFO)
    logging.getLogger("uvicorn.access").info(
        '%s - "%s %s HTTP/%s" %d', "1.2.3.4:5", "GET", '/x?token="&a=1', "1.1", 200,
    )
    assert caplog.records[0].args == ("1.2.3.4:5", "GET", '/x?token=[REDACTED]"&a=1', "1.1", 200)


def test_format_templates_with_secret_names_still_format(caplog, capsys):
    caplog.set_level(logging.INFO)
    log = logging.getLogger("carrot.test")
    log.info("key=%s", TOKEN)
    log.info("password=%s user=%s", TOKEN, "bob")
    log.info("%(name)s token=%(value)s", {"name": "ws", "value": TOKEN})
    log.info("count=%d secret=%r", 3, TOKEN)
    log.info("key=%s", "")
    log.info("close code=%d", 1000)
    assert TOKEN not in caplog.text
    assert [r.getMessage() for r in caplog.records] == [
        "key=[REDACTED]",
        "password=[REDACTED] user=bob",
        "ws token=[REDACTED]",
        "count=3 secret=[REDACTED]",
        "key=[REDACTED]",
        "close code=1000",
    ]
    assert caplog.records[-1].msg == "close code=%d"
    assert caplog.records[-1].args == (1000,)
    assert capsys.readouterr().err == ""


@pytest.fixture
def running_bridge(caplog):
    caplog.set_level(logging.INFO)
    config = uvicorn.Config(server.app, host="127.0.0.1", port=0, log_config=None)
    bridge = uvicorn.Server(config)
    thread = threading.Thread(target=bridge.run, daemon=True)
    thread.start()
    deadline = time.time() + 15
    while not bridge.started:
        assert time.time() < deadline, "bridge did not start"
        time.sleep(0.05)
    port = bridge.servers[0].sockets[0].getsockname()[1]
    yield port
    bridge.should_exit = True
    thread.join(timeout=10)


def test_bridge_logs_never_contain_browser_token(running_bridge, caplog):
    port = running_bridge
    with connect(f"ws://127.0.0.1:{port}/ws?browser_id=redaction-test&browser_token={TOKEN}"):
        pass
    with pytest.raises(InvalidStatus):
        with connect(f"ws://127.0.0.1:{port}/ws?browser_id=redaction-test&browser_token=wrong-{TOKEN}"):
            pass
    assert httpx.get(f"http://127.0.0.1:{port}/status?token={TOKEN}").status_code == 200

    deadline = time.time() + 5
    while "/status?token=[REDACTED]" not in caplog.text and time.time() < deadline:
        time.sleep(0.05)

    assert TOKEN not in caplog.text
    assert "/ws?browser_id=redaction-test&browser_token=[REDACTED]" in caplog.text
    assert "/status?token=[REDACTED]" in caplog.text

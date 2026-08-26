"""The guards on URL to PDF.

These are the tests that matter most in this codebase: a gap here turns the
endpoint into a request forwarder inside our own network.
"""

import socket

import pytest

from app.services.urlsafety import UnsafeUrl, validate


@pytest.fixture
def resolves_to(monkeypatch):
    """Pin name resolution so the tests never depend on DNS or the network."""

    def _resolve(address: str):
        def fake(host, port, *args, **kwargs):
            family = socket.AF_INET6 if ":" in address else socket.AF_INET
            return [(family, socket.SOCK_STREAM, 6, "", (address, port or 443))]

        monkeypatch.setattr(socket, "getaddrinfo", fake)

    return _resolve


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/",
        "http://localhost/admin",
        "http://169.254.169.254/latest/meta-data/",  # cloud metadata
        "http://10.0.0.5/",
        "http://192.168.1.1/",
        "http://172.16.4.4/",
        "http://[::1]/",
        "file:///etc/passwd",
        "ftp://example.com/x",
        "gopher://example.com/",
    ],
)
def test_refuses_anything_not_public(url: str) -> None:
    with pytest.raises(UnsafeUrl):
        validate(url)


def test_allows_a_public_address(resolves_to) -> None:
    resolves_to("93.184.216.34")
    assert validate("https://example.com/") == "https://example.com/"


def test_refuses_a_public_name_that_resolves_somewhere_private(resolves_to) -> None:
    """The attack the string check misses: a hostname you control, pointed home."""
    resolves_to("127.0.0.1")
    with pytest.raises(UnsafeUrl):
        validate("https://totally-innocent.example.com/")


def test_rejects_a_url_with_no_host() -> None:
    with pytest.raises(UnsafeUrl):
        validate("https://")

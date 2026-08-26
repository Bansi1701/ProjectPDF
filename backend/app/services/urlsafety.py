"""Guards for fetching a URL someone else supplied.

A "render this web page" endpoint is a request forwarder that runs inside our
network. Without checks it will happily fetch `http://169.254.169.254/`, the
cloud metadata service, and render the instance's credentials into a PDF for
whoever asked. It will also reach internal services that were never meant to
face the internet, because from their side the request came from us.

So: resolve the name first, check every address it resolves to, and refuse
anything that is not a public one. Resolving first matters — a hostname under
someone else's control can point at 127.0.0.1, and checking the string instead
of the address catches nothing.
"""

import ipaddress
import socket
from urllib.parse import urlsplit

# Only these reach the outside world. Anything else is a local scheme.
ALLOWED_SCHEMES = frozenset({"http", "https"})


class UnsafeUrl(ValueError):
    """The URL resolves somewhere we refuse to fetch from."""


def _is_public(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local  # includes 169.254.169.254, the metadata service
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def validate(url: str) -> str:
    """Return the URL if it is safe to fetch, else raise UnsafeUrl."""
    parts = urlsplit(url.strip())

    if parts.scheme not in ALLOWED_SCHEMES:
        raise UnsafeUrl(
            f"Only http and https are supported, not {parts.scheme or 'a missing scheme'}."
        )

    host = parts.hostname
    if not host:
        raise UnsafeUrl("That URL has no host.")

    try:
        # Every address the name resolves to, not just the first.
        infos = socket.getaddrinfo(host, parts.port or (443 if parts.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise UnsafeUrl(f"That host could not be resolved: {exc.strerror or exc}") from exc

    addresses = {info[4][0] for info in infos}
    if not addresses:
        raise UnsafeUrl("That host resolved to no addresses.")

    for address in addresses:
        if not _is_public(address):
            raise UnsafeUrl(
                "That URL points inside a private network. "
                "This service only fetches publicly reachable pages."
            )

    return url

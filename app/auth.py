import base64
import secrets

from fastapi import Request


def is_authorized(request: Request, username: str, password: str) -> bool:
    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "basic" or not token:
        return False
    try:
        decoded = base64.b64decode(token).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return False
    supplied_username, separator, supplied_password = decoded.partition(":")
    if not separator:
        return False
    return secrets.compare_digest(supplied_username, username) and secrets.compare_digest(
        supplied_password,
        password,
    )

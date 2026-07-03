from base64 import b64encode

from app.auth import is_authorized


class RequestStub:
    def __init__(self, authorization: str = ""):
        self.headers = {"authorization": authorization} if authorization else {}


def basic_auth(username: str, password: str) -> str:
    token = b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def test_basic_auth_accepts_matching_credentials():
    request = RequestStub(basic_auth("sushanth", "secret"))

    assert is_authorized(request, "sushanth", "secret")


def test_basic_auth_rejects_missing_and_wrong_credentials():
    assert not is_authorized(RequestStub(), "sushanth", "secret")
    assert not is_authorized(RequestStub(basic_auth("sushanth", "wrong")), "sushanth", "secret")
    assert not is_authorized(RequestStub("Bearer abc"), "sushanth", "secret")

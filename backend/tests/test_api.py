from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_returns_ok() -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_status_reports_not_launched() -> None:
    response = client.get("/api/v1/status")
    assert response.status_code == 200

    body = response.json()
    assert body["launched"] is False
    assert body["name"] == "HatePDF API"

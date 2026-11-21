from __future__ import annotations

import pytest

from errors import ApiError
from schemas import SizingMode, SizingRequest, TradeSide
from sizing import calculate_position_size, round_down_to_step


def make_request(**fields: object) -> SizingRequest:
    return SizingRequest.model_validate(fields)


class TestFixedCash:
    def test_whole_shares_round_down(self) -> None:
        result = calculate_position_size(
            make_request(mode="fixed_cash", entry_price=33.0, cash_amount=1000)
        )
        assert result.shares == 30  # 1000 / 33 = 30.30 -> 30
        assert result.notional == 990.0
        assert result.risk_amount is None
        assert result.targets == []

    def test_reports_risk_when_stop_given(self) -> None:
        result = calculate_position_size(
            make_request(mode="fixed_cash", entry_price=50, stop_price=48, cash_amount=5000)
        )
        assert result.shares == 100
        assert result.side == TradeSide.LONG
        assert result.risk_amount == 200.0
        assert result.stop_distance_pct == 4.0

    def test_fractional_shares(self) -> None:
        result = calculate_position_size(
            make_request(
                mode="fixed_cash", entry_price=30000, cash_amount=1000, allow_fractional=True
            )
        )
        assert result.shares == pytest.approx(0.0333)


class TestEquityPct:
    def test_percent_of_equity_notional(self) -> None:
        result = calculate_position_size(
            make_request(mode="equity_pct", entry_price=25, account_equity=50_000, equity_pct=10)
        )
        assert result.shares == 200
        assert result.notional == 5000.0
        assert result.notional_pct_of_equity == 10.0

    def test_requires_equity(self) -> None:
        with pytest.raises(ApiError) as raised:
            calculate_position_size(make_request(mode="equity_pct", entry_price=25, equity_pct=10))
        assert raised.value.error_code == "missing_field"


class TestRiskToStop:
    def test_long_with_risk_pct(self) -> None:
        result = calculate_position_size(
            make_request(
                mode="risk_to_stop",
                entry_price=100,
                stop_price=97.5,
                account_equity=25_000,
                risk_pct=1,
            )
        )
        # risk budget 250 / stop distance 2.5 = 100 shares
        assert result.shares == 100
        assert result.risk_amount == 250.0
        assert result.risk_pct_of_equity == 1.0
        assert [target.price for target in result.targets] == [102.5, 105.0, 107.5]

    def test_short_with_risk_cash(self) -> None:
        result = calculate_position_size(
            make_request(mode="risk_to_stop", entry_price=40, stop_price=42, risk_cash=300)
        )
        assert result.side == TradeSide.SHORT
        assert result.shares == 150
        assert [target.price for target in result.targets] == [38.0, 36.0, 34.0]

    def test_realised_risk_never_exceeds_budget(self) -> None:
        result = calculate_position_size(
            make_request(mode="risk_to_stop", entry_price=10.37, stop_price=9.91, risk_cash=100)
        )
        assert result.risk_amount is not None and result.risk_amount <= 100

    def test_max_notional_caps_position(self) -> None:
        result = calculate_position_size(
            make_request(
                mode="risk_to_stop",
                entry_price=100,
                stop_price=99.9,
                risk_cash=500,
                max_notional=10_000,
            )
        )
        assert result.shares == 100
        assert result.capped_by_max_notional is True

    def test_high_risk_and_leverage_warnings(self) -> None:
        result = calculate_position_size(
            make_request(
                mode="risk_to_stop",
                entry_price=100,
                stop_price=99,
                account_equity=10_000,
                risk_pct=5,
            )
        )
        assert any("above the 2%" in warning for warning in result.warnings)
        assert any("leverage" in warning for warning in result.warnings)

    def test_short_targets_below_zero_are_omitted(self) -> None:
        result = calculate_position_size(
            make_request(
                mode="risk_to_stop",
                entry_price=2,
                stop_price=3,
                risk_cash=10,
                target_r_multiples=[1, 3],
            )
        )
        assert [target.r_multiple for target in result.targets] == [1]
        assert result.warnings

    @pytest.mark.parametrize(
        ("fields", "expected_code"),
        [
            ({"stop_price": 100}, "zero_stop_distance"),
            ({"stop_price": 95, "side": "short"}, "stop_on_wrong_side"),
            ({}, "missing_field"),
            ({"stop_price": 95, "risk_cash": 10, "risk_pct": 1}, "ambiguous_risk_budget"),
            ({"stop_price": 95}, "missing_field"),
        ],
    )
    def test_rejects_invalid_input(self, fields: dict[str, object], expected_code: str) -> None:
        base_fields: dict[str, object] = {"mode": SizingMode.RISK_TO_STOP, "entry_price": 100}
        with pytest.raises(ApiError) as raised:
            calculate_position_size(make_request(**base_fields, **fields))
        assert raised.value.error_code == expected_code


def test_round_down_to_step() -> None:
    from decimal import Decimal

    assert round_down_to_step(Decimal("123.987"), Decimal("0.5")) == Decimal("123.5")
    assert round_down_to_step(Decimal("0.99"), Decimal("1")) == Decimal("0")


class TestSizingEndpoint:
    def test_calculates(self, client) -> None:
        response = client.post(
            "/api/v1/sizing/calculate",
            json={"mode": "risk_to_stop", "entry_price": 50, "stop_price": 49, "risk_cash": 100},
        )
        assert response.status_code == 200
        assert response.json()["shares"] == 100

    def test_domain_error_envelope(self, client) -> None:
        response = client.post(
            "/api/v1/sizing/calculate",
            json={"mode": "risk_to_stop", "entry_price": 50, "stop_price": 50, "risk_cash": 100},
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "zero_stop_distance"

    def test_validation_error_envelope(self, client) -> None:
        response = client.post("/api/v1/sizing/calculate", json={"mode": "nope", "entry_price": -1})
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_error"

    def test_requires_token_when_configured(self, authed_client) -> None:
        payload = {"mode": "fixed_cash", "entry_price": 10, "cash_amount": 100}
        assert authed_client.post("/api/v1/sizing/calculate", json=payload).status_code == 401
        authorised = authed_client.post(
            "/api/v1/sizing/calculate",
            json=payload,
            headers={"Authorization": "Bearer test-token-not-a-secret"},
        )
        assert authorised.status_code == 200

"""Position sizing and risk formulas.

Three modes are supported:

``fixed_cash``
    Deploy a fixed dollar notional: ``shares = cash_amount / entry_price``.
``equity_pct``
    Deploy a percent of account equity: ``shares = equity * pct / 100 / entry_price``.
``risk_to_stop``
    Size so that hitting the stop loses a fixed risk budget:
    ``shares = risk_budget / |entry_price - stop_price|`` where the budget is either
    ``risk_cash`` dollars or ``account_equity * risk_pct / 100``.

All arithmetic is done with ``Decimal`` and share counts are always rounded *down*
to the lot step, so the realised risk never exceeds the requested budget.
"""

from __future__ import annotations

from decimal import ROUND_DOWN, Decimal

from errors import ApiError
from schemas import (
    PriceTarget,
    SizingMode,
    SizingRequest,
    SizingResponse,
    TradeSide,
)

DEFAULT_WHOLE_SHARE_STEP = Decimal("1")
DEFAULT_FRACTIONAL_STEP = Decimal("0.0001")
HIGH_RISK_PCT_THRESHOLD = Decimal("2")
HUNDRED = Decimal("100")
CENT = Decimal("0.01")
PRICE_PRECISION = Decimal("0.000001")
PCT_PRECISION = Decimal("0.0001")


def _to_decimal(value: float) -> Decimal:
    # str() avoids binary-float artefacts such as Decimal(0.1) == 0.1000000000000000055...
    return Decimal(str(value))


def _validation_error(error_code: str, message: str) -> ApiError:
    return ApiError(422, error_code, message)


def resolve_trade_side(
    entry_price: Decimal, stop_price: Decimal | None, requested_side: TradeSide | None
) -> TradeSide | None:
    """Infer long/short from the stop location and reject contradictory input."""
    if stop_price is None:
        return requested_side
    if stop_price == entry_price:
        raise _validation_error("zero_stop_distance", "stop_price must differ from entry_price")
    side_implied_by_stop = TradeSide.LONG if stop_price < entry_price else TradeSide.SHORT
    if requested_side is not None and requested_side != side_implied_by_stop:
        raise _validation_error(
            "stop_on_wrong_side",
            f"A {requested_side.value} stop must be "
            f"{'below' if requested_side == TradeSide.LONG else 'above'} the entry price",
        )
    return side_implied_by_stop


def _require(value: float | None, field_name: str, mode: SizingMode) -> Decimal:
    if value is None:
        raise _validation_error(
            "missing_field", f"'{field_name}' is required for mode '{mode.value}'"
        )
    return _to_decimal(value)


def _resolve_risk_budget(request: SizingRequest) -> Decimal:
    if request.risk_cash is not None and request.risk_pct is not None:
        raise _validation_error(
            "ambiguous_risk_budget", "Provide either risk_cash or risk_pct, not both"
        )
    if request.risk_cash is not None:
        return _to_decimal(request.risk_cash)
    if request.risk_pct is not None:
        account_equity = _require(request.account_equity, "account_equity", request.mode)
        return account_equity * _to_decimal(request.risk_pct) / HUNDRED
    raise _validation_error(
        "missing_field", "risk_to_stop requires either 'risk_cash' or 'risk_pct'"
    )


def _unrounded_share_count(
    request: SizingRequest, entry_price: Decimal, stop_distance: Decimal | None
) -> Decimal:
    if request.mode == SizingMode.FIXED_CASH:
        cash_amount = _require(request.cash_amount, "cash_amount", request.mode)
        return cash_amount / entry_price

    if request.mode == SizingMode.EQUITY_PCT:
        account_equity = _require(request.account_equity, "account_equity", request.mode)
        equity_pct = _require(request.equity_pct, "equity_pct", request.mode)
        return account_equity * equity_pct / HUNDRED / entry_price

    if stop_distance is None:
        raise _validation_error("missing_field", "'stop_price' is required for mode 'risk_to_stop'")
    return _resolve_risk_budget(request) / stop_distance


def round_down_to_step(quantity: Decimal, step: Decimal) -> Decimal:
    whole_steps = (quantity / step).to_integral_value(rounding=ROUND_DOWN)
    return (whole_steps * step).normalize()


def _price_targets(
    side: TradeSide | None,
    entry_price: Decimal,
    stop_distance: Decimal | None,
    r_multiples: list[float],
    warnings: list[str],
) -> list[PriceTarget]:
    if side is None or stop_distance is None:
        return []
    direction = Decimal(1) if side == TradeSide.LONG else Decimal(-1)
    targets: list[PriceTarget] = []
    for r_multiple in r_multiples:
        target_price = entry_price + direction * _to_decimal(r_multiple) * stop_distance
        if target_price <= 0:
            warnings.append(f"{r_multiple}R target is below zero and was omitted")
            continue
        targets.append(
            PriceTarget(
                r_multiple=r_multiple,
                price=float(target_price.quantize(PRICE_PRECISION)),
            )
        )
    return targets


def _as_money(amount: Decimal | None) -> float | None:
    return None if amount is None else float(amount.quantize(CENT))


def _as_pct(percentage: Decimal | None) -> float | None:
    return None if percentage is None else float(percentage.quantize(PCT_PRECISION))


def calculate_position_size(request: SizingRequest) -> SizingResponse:
    entry_price = _to_decimal(request.entry_price)
    stop_price = None if request.stop_price is None else _to_decimal(request.stop_price)
    side = resolve_trade_side(entry_price, stop_price, request.side)
    stop_distance = None if stop_price is None else abs(entry_price - stop_price)
    account_equity = None if request.account_equity is None else _to_decimal(request.account_equity)
    warnings: list[str] = []

    unrounded_shares = _unrounded_share_count(request, entry_price, stop_distance)

    capped_by_max_notional = False
    if request.max_notional is not None:
        max_affordable_shares = _to_decimal(request.max_notional) / entry_price
        if unrounded_shares > max_affordable_shares:
            unrounded_shares = max_affordable_shares
            capped_by_max_notional = True
            warnings.append("Position was reduced to respect max_notional")

    if request.lot_size is not None:
        lot_step = _to_decimal(request.lot_size)
    elif request.allow_fractional:
        lot_step = DEFAULT_FRACTIONAL_STEP
    else:
        lot_step = DEFAULT_WHOLE_SHARE_STEP
    shares = round_down_to_step(unrounded_shares, lot_step)

    if shares == 0:
        warnings.append("Position size rounds to zero; increase the budget or tighten the stop")

    notional = shares * entry_price
    risk_amount = None if stop_distance is None else shares * stop_distance
    stop_distance_pct = None if stop_distance is None else stop_distance / entry_price * HUNDRED

    risk_pct_of_equity = None
    notional_pct_of_equity = None
    if account_equity is not None:
        notional_pct_of_equity = notional / account_equity * HUNDRED
        if risk_amount is not None:
            risk_pct_of_equity = risk_amount / account_equity * HUNDRED
        if notional > account_equity:
            warnings.append("Position notional exceeds account equity (requires leverage)")
        if risk_pct_of_equity is not None and risk_pct_of_equity > HIGH_RISK_PCT_THRESHOLD:
            warnings.append(
                f"Risk is {risk_pct_of_equity.quantize(CENT)}% of equity, above the "
                f"{HIGH_RISK_PCT_THRESHOLD}% guideline"
            )

    return SizingResponse(
        mode=request.mode,
        side=side,
        shares=float(shares),
        entry_price=request.entry_price,
        stop_price=request.stop_price,
        notional=float(notional.quantize(CENT)),
        stop_distance=None if stop_distance is None else float(stop_distance),
        stop_distance_pct=_as_pct(stop_distance_pct),
        risk_amount=_as_money(risk_amount),
        risk_pct_of_equity=_as_pct(risk_pct_of_equity),
        notional_pct_of_equity=_as_pct(notional_pct_of_equity),
        capped_by_max_notional=capped_by_max_notional,
        targets=_price_targets(
            side, entry_price, stop_distance, request.target_r_multiples, warnings
        ),
        warnings=warnings,
    )

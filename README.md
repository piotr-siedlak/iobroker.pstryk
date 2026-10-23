# ioBroker.pstryk

Adapter for the [Pstryk](https://pstryk.pl) API. Fetches prices, energy and cost data from
`/integrations/meter-data/unified-metrics/` and computes automation helpers locally.

## Installation

```
iobroker url https://github.com/piotr-siedlak/iobroker.pstryk/tarball/main
```

Enter the API key in the instance configuration (stored encrypted).

## Request policy

- One hourly request (prices + meter values + costs) at `HH:00:01`.
- Optional monthly (every 6 h) and yearly (every 12 h) totals; they always leave one request
  slot free so the hourly fetch is never delayed.
- Sliding window limiter (max 3/h, configurable lower), persisted across restarts; HTTP 429 and
  401/403 pause requests for an hour (or `Retry-After`).
- If the API answers HTTP 400, the adapter tries alternative request variants
  (`meter_values`/`meterValues`, with/without future window).

## Manual fetch

Write `true` to `commands.fetch_now` (button) to fetch prices immediately. This request is **not**
counted in the adapter's local limit (60 s cooldown between presses). Pstryk's own server limit
(3 heavy requests/hour) still applies — overusing the button can get HTTP 429 and block
automatic fetching for an hour.

## Objects

| Path | Content |
| --- | --- |
| `prices.rolling.00`–`23` | rolling 24 h; `00` = current hour. Fields: `buy_gross`, `buy_net`, `sell_gross`, `is_cheap`, `is_expensive`, `start_time`, `end_time`, `available` |
| `prices.current`, `prices.next` | same fields |
| `prices.today`, `prices.tomorrow` | JSON, min/max/avg, known hours |
| `prices.absolute.json` | all cached prices with real timestamps |
| `prices.statistics` | avg, min, max, diff to avg, attractiveness %, hours to next cheap, `run_now` |
| `prices.best_charge_window` | cheapest window of configured length |
| `cheapest_hours`, `most_expensive_hours` | consecutive windows (2,3,4,6,8 h) and non-consecutive sets |
| `energy`, `costs`, `prosumer` | `current`, `today`, `yesterday`, `month`, `year` — fields mirror the API |
| `raw` | last raw response, list of API fields seen |
| `info` | connection, last update, next update, last error, request count, stale flag, auth error |

Missing future prices are marked `available=false` — values are never shifted blindly.
Price units are not converted; set the unit in the configuration according to the API docs.

## Development

```
npm install && npm test
```

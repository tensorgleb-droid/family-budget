# Семейный бюджет

Админка для учёта доходов, расходов и сбережений: https://tensorgleb-droid.github.io/family-budget/

## Как устроено

- `index.html` — сайт на GitHub Pages: вход, обзор по месяцам, формы «+ Доход» и «+ Расход».
  В нём нет ни данных, ни паролей, ни токенов.
- `worker/` — маленький сервер на Cloudflare Workers (бесплатный тариф). Он проверяет логин и пароль,
  выдаёт сессию на 30 дней и читает/пишет данные в приватный репозиторий
  `tensorgleb-droid/family-budget-data` через GitHub API. Токен GitHub хранится только в секретах Worker.
- `api.json` — адрес сервера; его записывает workflow после деплоя.

Данные (в приватном репо):
- `data/expenses.json` — записи из Telegram-бота (`tg-*`) и с сайта (`web-*`). Бот трогает только `tg-*`.
- `data/history.json` — старые журналы, только чтение.
- `data/settings.json` — сбережения сейчас, цель, доход в месяц.

## Настройка (один раз)

В репозитории: Settings → Secrets and variables → Actions → New repository secret:

| Секрет | Что это |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create Token → шаблон «Edit Cloudflare Workers» |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare → Workers & Pages, справа «Account ID» |
| `DATA_REPO_TOKEN` | GitHub → Settings → Developer settings → Fine-grained tokens: только репо `family-budget-data`, Contents: Read and write |
| `BUDGET_USERS` | `логин:пароль,логин:пароль` |

Потом Actions → Deploy API → Run workflow. Сервер выложится, а адрес запишется в `api.json`.

Сменить пароли: обновить секрет `BUDGET_USERS` и снова запустить Deploy API. Все старые сессии при этом сбрасываются.

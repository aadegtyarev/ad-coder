# Экономика колинга: на чём экономить и почему

Ресёрч под цель проекта — «максимально эффективно работать с разными
провайдерами и управлять окном контекста». Цифры проверены пробой по
встроенному каталогу pi-ai **0.85.1** (`getBuiltinModels(provider)`),
snapshot от 2026-09-11. Цены за 1M токенов, в единицах каталога.

Это не таблица трюков — это обоснование, почему трюки нельзя зашить
константами: экономически верное на одном провайдере убыточно на другом.

## Актуальные цены (не путать со старыми gpt-4)

| модель | ctx | in | out | cacheRead | cacheWrite | out/in | in/cR |
|---|---|---|---|---|---|---|---|
| deepseek-v4-flash | 1M | 0.14 | 0.28 | 0.0028 | 0 | 2× | 50× |
| deepseek-v4-pro | 1M | 0.435 | 0.87 | 0.0036 | 0 | 2× | **120×** |
| gpt-5-nano | 400k | 0.05 | 0.4 | 0.005 | 0 | **8×** | 10× |
| gpt-5-mini | 400k | 0.25 | 2 | 0.025 | 0 | **8×** | 10× |
| gpt-5 | 400k | 1.25 | 10 | 0.125 | 0 | **8×** | 10× |
| gpt-5-pro | 400k | 15 | 120 | 0 (?) | 0 | 8× | ? |
| gpt-5.4 (codex) | 272k | 2.5 | 15 | 0.25 | 0 | 6× | 10× |
| gpt-5.5 (codex) | 272k | 5 | 30 | 0.5 | 0 | 6× | 10× |
| gpt-4.1-nano | 1M | 0.1 | 0.4 | 0.025 | 0 | 4× | 4× |
| anthropic/fable-5 | 1M | 10 | 50 | 1 | **12.5** | 5× | 10× |
| MiniMax-M3 | 1M | 0.3 | 1.2 | 0.06 | 0 | 4× | 5× |
| MiniMax-M2.7 | 205k | 0.3 | 1.2 | 0.06 | 0.375 | 4× | 5× |
| groq/llama-3.3-70b | 131k | 0.59 | 0.79 | 0 (?) | 0 | 1.3× | ? |
| qwen-token-plan/* | — | 0 | 0 | 0 | 0 | — | — |
| lmstudio/* (локально) | зависит | — | — | — | — | — | — |

`(?)` у `cacheRead: 0` — см. «Неоднозначность нуля» ниже.

## Пять рычагов по убыванию денег

1. **Не инвалидировать префикс кэша.** Превращает `input` в `cacheRead`:
   на deepseek-pro это 120×, на gpt-5 10×, на minimax 5×. Множитель — не
   число чтений файла, а число ходов: контекст переотправляется каждый ход,
   и весь он либо попадает в кэш, либо нет. Механика — **append-only**:
   собирать контекст по возрастанию волатильности (системный промт →
   контракт роли → стабильные факты о проекте → срезы файлов → хвост
   диалога) и никогда не вставлять в середину. Срез, вставленный в середину,
   инвалидирует префикс и выходит **дороже** целого файла, дописанного в конец.

2. **Меньше выходных токенов.** `out/in` — самый широкий разброс: от 1.3×
   (groq) до 8× (gpt-5). Один выходной токен на gpt-5 стоит как 8 входных и
   как **80 кэшированных**. Болтливая роль на дорогой модели — самая дорогая
   ошибка из доступных. Дифф вместо файла, вердикт вместо пересказа, «ссылайся
   на строки, не цитируй код». Бюджет вывода на роль (`maxTokens`).

3. **Усекать вывод инструментов до входа в контекст.** Тест, уронивший 3000
   строк стектрейса, оплачивается каждый последующий ход до конца сессии.
   Нужен усекатель с ручкой раскрытия: `…1840 строк опущено, expand(id)`.

4. **Структура вместо целых файлов.** `outline(file)` → символы и диапазоны
   строк (~50 токенов на файл 2000 строк), `read(file, symbol)` → только
   нужный кусок. `typescript-lsp` даёт `documentSymbol` готовым. Ключевое:
   **целое чтение — то, что просят явно**, а не дефолт. Дефолт определяет
   поведение. Ловушка: срез, после которого понадобились три уточняющих
   чтения, — это четыре хода вместо одного, каждый переотправляет контекст.
   Меньше токенов на чтение, но больше ходов = дороже. Один толстый
   инструмент (outline + нужные срезы разом) дешевле трёх тонких.

5. **Малые промты.** Экономически самый слабый рычаг: системный промт —
   самый кэшируемый объект в запросе, после первого хода стоит ~0.008× от
   input на DeepSeek. Уменьшить его вдвое почти ничего не экономит. Как фича
   **качества** (меньше размывания инструкций, меньше конкуренции за внимание)
   он ценен — но продавать его как экономию не надо.

## Три режима оплаты — стратегия инвертируется

Правильная стратегия не набор фиксированных трюков, а измерительный цикл,
выбирающий трюки под модель. Три режима, и они несовместимы:

- **Поштучно** — DeepSeek, OpenAI, Codex, Anthropic, MiniMax. Оптимизируем деньги.
  - `cacheWrite = 0` почти везде → «кэшируй всегда» верно по умолчанию.
  - **Anthropic — единственное исключение:** `cacheWrite = 12.5` при
    `input = 10`. Записать в кэш на 25% дороже, чем отправить некэшированным.
    Кэш окупается только если префикс прочитан ≥2 раз. Одноразовый префикс
    кэшировать — убыток. Поэтому Pi отключает cache-write на компакции.
- **Предоплаченный план** — `qwen-token-plan/*`: в каталоге **все цены нули**,
  включая input/output. Леджер покажет $0 при реальном расходе квоты.
  Оптимизировать надо квоту и латентность, не деньги.
- **Локально** — LM Studio, vLLM: цен нет, кэша обычно нет, окно маленькое
  (напр. qwen 14B ≈ 32k против 1M у DeepSeek). Оптимизируем окно и латентность.

## Неоднозначность `cacheRead: 0`

`cacheRead: 0` в каталоге значит либо «бесплатно», либо «не поддерживается» —
по цене `gpt-5-pro` и `groq` не различить. Разрешается только флагами
`compat` (`supportsExplicitPromptCacheMode`, `cacheControlFormat`) плюс
наблюдением: пришёл ли непустой `usage.cacheRead` в реальном ответе. Прямой
аргумент за то, что матрица возможностей должна быть **эмпирической**, а не
таблицей констант — часть правды узнаётся только из первого живого ответа,
и леджер её уже фиксирует.

## Две метрики, делающие остальное измеримым

Обе считаются из того, что леджер уже пишет (`cacheRead`, `cacheWrite`,
`cost` по полям, атрибуция по роли/шагу).

- **`cacheEfficiency = cacheRead / (cacheRead + input)`** на роль и ход.
  Падение с 0.9 до 0.2 = что-то сломало префикс, и видно **какая роль на
  каком шаге**.
- **`breakEvenReads = cacheWrite / (input − cacheRead)`** — порог окупаемости
  кэша, вычисляемый, не угаданный. fable-5: 12.5/(10−1) = 1.4 → префикс
  должен переиспользоваться ≥2 раз. DeepSeek: 0 → всегда.

## Профили: намерение → матрица → модель

Профиль не «имя модели на роль», а тройка (модель + бюджет вывода + политика
кэша), потому что все три зависят от модели:

```ts
profile("cheap", {
  locator:  { model: "lmstudio/qwen-14b",          maxOutput: 2_000 },
  coder:    { model: "deepseek/deepseek-v4-flash", maxOutput: 8_000 },
  reviewer: { model: "deepseek/deepseek-v4-pro",   maxOutput: 4_000 },
});
profile("max", {
  coder:    { model: "openai-codex/gpt-5.5",       maxOutput: 4_000 }, // out/in=6, жмём вывод
  reviewer: { model: "anthropic/fable-5",          cacheRetention: "long" },
});
```

Три принципа:

1. **Профиль называет намерение, матрица разрешает в модель.** `{ tier: "cheap" }`
   вместо жёсткого id → профиль переносим между провайдерами; нет ключа
   OpenAI — `cheap` уезжает на DeepSeek без правки workflow.
2. **Матрица отказывает, а не молчит.** Роль просит `cacheRetention: "long"`,
   модель формат не поддерживает (DeepSeek!) — `defineRole` говорит это на
   входе, а не глотает молча. Ручка есть, эффекта нет — надо предупредить.
3. **Бюджет вывода наследуется от `out/in`, не выбирается на глаз.** Одна роль
   на gpt-5 (8×) и на groq (1.3×) заслуживает разных лимитов.

Что замыкает цикл: леджер атрибутирует стоимость по роли и шагу → один
workflow под двумя профилями → **сравнить два JSONL**, а не спорить, какой
дешевле. Профили без измерения — гадание; измерение без профилей —
бесполезное знание. Поэтому порядок: матрица + метрики раньше, профили позже.

## Три ловушки

- **Компакция как кэш-бомба.** Стоит трижды: вызов суммаризации, потеря
  информации, инвалидация префикса всего, что после неё. На Anthropic ещё и
  `cacheWrite` заново. Компактить надо **по измерению**, а не по достижению
  порога — и писать стоимость самой компакции отдельной записью в леджер,
  иначе не узнать, сэкономила она или потратила.
- **Экономия ходами против экономии токенами.** Любая «умная» многошаговая
  разведка переотправляет контекст на каждом шаге.
- **Окно 1M провоцирует лень.** Полный 1M контекст без кэша на deepseek-pro —
  $0.435 за ход, 20 ходов — $8.7. Бюджет нужен не потому, что не влезет, а
  потому что влезет.

## Ещё одна ось экономии: дисциплина оператора

Своевременный чекпойнт и обновление документации — тоже экономия. Ценный
ресёрч (эти цифры, находки по pi-ai), потерянный со сброшенной сессией,
переоплачивается заново — теми же прогонами и теми же токенами. Правило:
записывать проверенное в `docs/` по ходу, а не «потом». Этот файл — пример;
`docs/pi-capabilities.md` — второй.

## Tool-activity implementation dogfood (2026-09-12)

The checkpointed built-in pipeline run started on 2026-09-12 and ended on
2026-09-13 after 40m52s. It stopped in Coder before review because optional
follow-up metadata failed semantic validation. Exact resumable state and the
per-stage table are recorded in
[`reviews/2026-09-13-tool-observability-dogfood.md`](reviews/2026-09-13-tool-observability-dogfood.md).
The run consumed 21,987,720 total tokens (660,313 fresh input, 21,256,064 cache
read, 71,343 output), cost $16.069887, and produced no accepted result. Coder
alone accounted for $13.698824 and 20,224,128 cache-read tokens. This replaces
the earlier lack of checkpointed telemetry.

The later continuation Coder stage ran through a worker API that did not expose a
pipeline checkpoint or provider usage envelope to the role. The safe run
identifier, provider/model, effective thinking level, monotonic duration,
input/cache/output
and reasoning tokens, provider-reported cost, review rounds, context strategy,
and accepted-result total are therefore **unavailable**; none are estimated.
There is no checkpoint link to publish honestly. Runtime support added by this
change records these fields for subsequent checkpointed pipeline runs, which can
supply the missing profile-efficiency evidence without copying checkpoint,
ledger, prompt, or activity contents into documentation.

Two later standalone Reviewer passes cost $0.30563720 and $0.24370560 and took
about 213 and 156 seconds. Their in-memory ledgers did not survive process exit,
so token categories are unavailable and not estimated. Both emitted only the
10-second heartbeat while working; no semantic tool activity appeared. This is
direct evidence that standalone role usage persistence and activity coverage
still need improvement even though the reviewed activity core passed its gates.

The 2026-09-12 minimal-console planning pass consumed 454,696 input tokens,
323,840 cached tokens, and 8,889 output tokens (planner: 279,041 / 187,392 /
5,811; security: 175,655 / 136,448 / 3,078). It was plan-only, so it produced
no run checkpoint. This is planning-usage evidence, not provider billing.

## Historical live-pipeline observations (2026-09-12)

The retired handoff snapshot recorded two live DeepSeek observations: a single
`ad-coder role coder` run cost **$0.0035**, and a full `drive --auto` pipeline
cost **$0.0206**. They are small, workload-specific observations rather than
price claims or a benchmark, but remain useful evidence that the configured
DeepSeek paths had completed end-to-end at that time. The broader LDO-versus
DeepSeek comparison below also records the earlier `add.js` pipeline range of
$0.0018–0.0043.

## Native pipeline mode comparison (2026-09-13)

A self-hosted `ContextBudgetError` diagnostic change exercised three native modes.
These are directional observations over related but non-identical tasks, not a
like-for-like benchmark.

| mode | outcome | stage time | fresh / cached input | output / reasoning | provider cost |
|---|---|---:|---:|---:|---:|
| standalone Planner, Terra | usable plan | 58.2s | unavailable separately; 59,986 total | 2,696 / 741 | $0.089655 |
| manual pipeline, Luna Planner + Terra | approved in two review rounds; a later independent review found one blocker | 568.9s | 285,806 / 600,304 | 16,300 / 6,596 | $0.574809 |
| standalone Reviewer, Terra | found the escaped failed-compaction diagnostic blocker | 144.4s | unavailable separately; 264,937 total | 4,446 / 2,235 | $0.194311 |
| automatic pipeline fixing that blocker, Luna + Terra | approved in one review round | 471.5s | 196,549 / 942,592 | 16,215 / 7,605 | $0.543393 |

The manual run also proved durable stage recovery: its Coder hit 16 model turns,
then `--resume-run` continued the same checkpoint without repeating its $0.017926
Planner stage. Two external interruptions of the automatic run preserved completed
Coder/Planner work. A competing stale Reviewer was rejected by checkpoint CAS.

For tuning comparisons, record two scores rather than hiding quality inside cost:

- `Q` is the fraction of four evidence gates satisfied: usable implementation,
  focused regression, full project gates, and no blocker in the final independent
  review. A detected blocker stays failed until a later run fixes and reviews it.
- Weighted tokens `W = fresh + 0.1 × cached + 4 × (output + reasoning)`. The cache
  factor is a comparison convention, not provider billing. Report provider cost
  separately.
- Token efficiency `E_token = 1,000,000 × Q / W`; cost efficiency
  `E_cost = Q / providerCostUsd`. Higher is better.

On this evidence the manual run scored `Q=0.75`, `E_token=1.71`, `E_cost=1.30`.
The blocker-fix automatic run scored `Q=1`, `E_token=2.59`, `E_cost=1.84`. The
second task was narrower, so the difference justifies further controlled runs; it
does not prove automatic mode is universally more efficient. Focused review did
show a within-run reduction: fresh Reviewer input fell from 46,112 to 32,498,
cost from $0.173544 to $0.113465, and duration from 124.8s to 93.6s.

Candidate operating tiers for subsequent comparable dogfood are:

| tier | routing and mode | per-stage ceilings | intended use |
|---|---|---|---|
| economy | standalone role or manual workflow; Luna Planner, Terra Coder/Reviewer | 120s, 12 model turns, 32 tools, 200k input, $0.35 | bounded judgment or already-localized change |
| balanced | automatic pipeline; Luna Planner, Terra Coder/Reviewer | 240s, 32 model turns, 80 tools, 500k input, $1 | normal feature with one broad review and focused retries |
| quality | automatic pipeline; Terra Planner, Sol Coder, Terra or Sol Reviewer | 600s, 48 model turns, 128 tools, 750k input, $2 | architectural, elevated-risk, or failed lower-tier work |

These are experiment settings, not new defaults. Always retain hard stage budgets,
incremental handoffs, visible fallback, durable resume, and the same contract/test
gates across tiers. LDO should adopt the same stage envelopes, scoped handoffs,
activity events, checkpoint resume, and two-axis efficiency reporting before its
next comparison run.

### Standalone recovery and cheap-role calibration (2026-09-13)

A focused Security run on the standalone recovery fix used the native cheap
Security route. Its initial 10-model-turn ceiling paused after about 70 seconds;
resuming the same durable operation with a 16-turn ceiling reached `APPROVE` in
another 13.6 seconds for $0.018466. The shared ledger totals were 25,903 fresh
input, 106,496 cached input, 1,893 output, 1,249 reasoning, and $0.239553 across
11 responses. Thus 10 turns is too low for this focused Luna audit while 16 was
sufficient; no claim about other roles follows from this one sample.

The run also exposed and then verified recovery defects that faux tests alone had
missed: resume must drive Pi's active lane operation, stage usage must remain
cumulative, provider/model identity must remain fixed, and non-stage failures
must preserve both usage and the session lease. Future tier selection compares
total cost through final acceptance, including repair and re-review, rather than
assuming that either the cheapest or strongest model wins by list price.

## Измерено на себе: реальная стоимость постройки ad-coder через LDO (2026-09-11)

Прогнали `scripts/ldo-cost.sh` по транскриптам собственных implement-прогонов
(input + cache + output, list-цены Anthropic — НЕ биллинг). Три замера:

| прогон | стоимость | cache reads | output (то, что отчёт называет «стоимостью») |
|---|---|---|---|
| раннер | **$36.32** | 19.9M (95.8% ввода) | 60.9k (0.2%) |
| оркестрация | **$25.38** | 14.0M (96.2%) | 51.4k (0.2%) |
| submit_verdict | **$17.47** | 9.7M (94.5%) | 44.7k (0.2%) |

**Два вывода, которые переворачивают наивное чтение отчётов:**

1. **Число «output tokens» в результате прогона — это ~0.2% счёта.** 95%+ —
   это **cache reads** (10–20M токенов чтения кэша на прогон). Кто читает только
   output-дельту, недооценивает стоимость в **сотни раз**.

2. **Многоагентность платит re-read-налог.** Каждый свежий агент (planner,
   coder, reviewer, recorder) перечитывает кодбазу/план — отсюда 95% чтений
   кэша. Это открытый баг самого LDO (issue #31: «119.7M cache reads,
   $191 vs $1421 uncached»).

**Контраст, который и есть весь смысл проекта:**
- LDO построил фичу ad-coder за **$17–36** (Opus planner + Opus coder + Sonnet
  reviewer + Haiku recorder, list-rate Anthropic).
- Живой конвейер ad-coder построил фичу (add.js) за **$0.0018–0.0043** на DeepSeek.

Это ~4 порядка. add.js тривиальнее реальных фич — не яблоки к яблокам, — но
разрыв показывает: **стоимость доминируется выбором модели и межагентным
re-read'ом.** Пайплайн оправдан для рискованного ядра (независимое adversarial-
ревью реально ловило баги, planOnly ловил неверные допущения в брифах), но
платить Opus-list-rate ОДИНАКОВО за раннер и за add.js — расточительство. Матрица
+ профили + роутинг-по-сложности строятся именно чтобы сделать этот выбор
настраиваемым: дёшево там, где дорого не нужно.

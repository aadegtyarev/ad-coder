# Что Pi даёт ad-coder: проверенные факты

Разведка перед Phase 0. Всё ниже проверено чтением `dist/*.d.ts` установленных
пакетов **версии 0.85.1**, а не документации. Ссылки вида `pkg/dist/file.d.ts:NN`
указывают на файл внутри пакета; номера строк привязаны к 0.85.1 и при апгрейде
могут сдвинуться — проверяй по имени символа, а не по строке.

Пакеты: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`,
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
`@earendil-works/pi-telemetry`, `@earendil-works/chord`.

## Вывод: строимся на `pi-agent-core`, не на `pi-coding-agent`

`pi-coding-agent` — это готовое приложение (CLI + TUI + сессии на диске).
`pi-agent-core` — харнесс-рантайм под ним, и именно он отдаёт наружу
все четыре ручки, которые нужны ad-coder: модель, промт, тулы, политику
контекста и кэша.

`pi-coding-agent` **не** пробрасывает `cacheRetention` в обычный ход: во всём
пакете это поле встречается один раз — `dist/core/compaction/compaction.js:459`,
где жёстко выставлено `"none"` для запросов компакции. То есть через
`createAgentSession` управлять кэшем нельзя.

## Роль ≈ `AgentHarnessOptions`

`pi-agent-core/dist/harness/agent-harness.d.ts:617` — уже почти ровно та
сущность, которую я собирался проектировать:

```ts
interface AgentHarnessOptions<TContext> {
  session: Session;
  models: Models;
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  activeToolNames?: string[];
  tools?: AgentHarnessTool<TContext>[];
  systemPrompt?: string | ((toolContext, context) => string | Promise<string>);
  streamOptions?: AgentHarnessStreamOptions;
  retry?: RetryPolicy;
  compaction?: CompactionSettings;
  toolExecution?: "sequential" | "parallel";
  // ...
}
```

`Role` в ad-coder — это именованный, версионируемый, валидируемый пресет над
этим типом плюс наши поля (бюджет, лимит промта, политика хендоффа).
Писать свой агентный цикл не нужно.

## Кэш: управляемо, три уровня контроля

**1. Уровень запроса — `cacheRetention`.**
`pi-ai/dist/types.d.ts:40` → `type CacheRetention = "none" | "short" | "long"`,
поле `StreamOptions.cacheRetention` (`types.d.ts:128`), по умолчанию `"short"`.

Провайдер отображает его сам — `pi-ai/dist/api/anthropic-messages.js:29`:

```js
function getCacheControl(model, cacheRetention, env) {
  const retention = resolveCacheRetention(cacheRetention, env);
  if (retention === "none") return { retention };
  const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention
    ? "1h" : undefined;
  return { retention, cacheControl: { type: "ephemeral", ...(ttl && { ttl }) } };
}
```

Есть env-фолбэк `PI_CACHE_RETENTION=long` (`pi-ai/dist/api/pi-messages.js:239`)
— грубый, на весь процесс. Для роли он не годится, нам нужен per-request.

**2. Уровень роли — `AgentHarnessStreamOptions`.**
`pi-agent-core/dist/harness/types.d.ts:85` содержит `cacheRetention`, а рантайм
даёт `getStreamOptions(context)` / `setStreamOptions(options, context)`
(`harness/runtime/harness.d.ts:36-37`). Это и есть per-role политика кэша.

**3. Уровень хода — хук `before_request`.**
`agent-harness.d.ts:520`:

```ts
before_request: {
  event: { model: Model<Api>; step: "assistant" | "deferred" | "compaction" | "branch_summary";
           attempt: number; streamOptions: AgentHarnessStreamOptions };
  result: { streamOptions?: AgentHarnessStreamOptionsPatch } | undefined;
}
```

Поле `step` позволяет ad-coder вести разную политику для основного хода и для
служебных вызовов — например `"long"` на assistant-ходах длинного прогона и
`"none"` на одноразовых суммаризациях.

**Ограничение, которое надо знать.** Расстановка брейкпоинтов —
жёсткая конвенция pi-ai, а не наш выбор. `pi-ai/dist/types.d.ts:515` о
`cacheControlFormat: "anthropic"`: маркеры ставятся на системный промт, последнее
определение тула и последний текстовый блок user / assistant / tool-result.
Произвольная расстановка возможна только через хук `before_payload`
(`agent-harness.d.ts:531`), который получает сырой `payload: unknown` и может
вернуть изменённый — то есть ценой провайдер-специфичной хирургии над телом
запроса. **Не делаем этого в Phase 0-2.** Сначала выясняем на практике, упираемся
ли мы вообще в конвенцию: три уровня `cacheRetention` могут закрыть задачу.

## Статистика: считать стоимость не надо

`pi-ai/dist/types.d.ts:265` — `Usage` приходит от провайдера уже с разбивкой,
включая деньги:

```ts
interface Usage {
  input: number; output: number;
  cacheRead: number; cacheWrite: number;
  cacheWrite1h?: number;   // подмножество cacheWrite с ttl 1h, только Anthropic
  reasoning?: number;      // подмножество output
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
```

Ценообразование живёт в метаданных модели: `Model.cost: ModelCost`
(`types.d.ts:217`), с тарифными порогами по размеру запроса (`types.d.ts:713`).

Значит `Ledger` — это **не** калькулятор, а атрибутор: он навешивает на каждый
`Usage` измерения, которых у Pi нет (роль, шаг workflow, прогон) и
складывает по ним. Ровно этой разбивки нет ни у одного инструмента: `get_session_stats`
в Pi даёт накопительный итог по сессии, без разреза по ролям.

Осторожно с двойным счётом: `usage` в событии `message_update` **накопительный**,
а не за ход. Дельту считает потребитель. `cacheWrite1h ⊂ cacheWrite` и
`reasoning ⊂ output` — при суммировании это подмножества, не слагаемые.

## Контекст: бюджет уже параметризован

`pi-agent-core/dist/harness/compaction/compaction.d.ts:31`:

```ts
interface CompactionSettings { enabled: boolean; reserveTokens: number; keepRecentTokens: number }
```

Плюс готовые утилиты: `calculateContextTokens(usage)`, `getLastAssistantUsage(entries)`,
`ContextUsageEstimate { tokens, usageTokens, trailingTokens, lastUsageIndex }`
(там же, :42-55). `Model.contextWindow` есть в метаданных.

Значит pre-flight «этот ход не влезет в бюджет роли» строится на готовых
функциях, а `CompactionSettings` задаётся **на роль**, а не на процесс.

## Хуки — это и есть слой плагинов

`HookMap` (`agent-harness.d.ts:485`) — полный список сем расширения:

| Хук | Что можно | Зачем ad-coder |
|---|---|---|
| `before_run` | подменить стартовые сообщения | инъекция контракта роли |
| `before_drive` | реакция на `run` / `compaction` / `navigation` | учёт служебных вызовов |
| `before_run_end` | вернуть `followUp` | цикл code⇄review без внешнего драйвера |
| `transform_context` | подменить `messages` и `systemPrompt` | дисциплина малых промтов, сжатие |
| `before_request` | патч `streamOptions` | политика кэша на ход |
| `before_payload` | подменить сырое тело запроса | аварийный люк для брейкпоинтов |
| `after_response` | статус, заголовки, `SettledAssistantMessage` | леджер, разбор лимитов |

Регистрация — `HookRegistry.on(name, handler, { id })`, возвращает функцию
отписки (`harness/hooks.d.ts`). Плагину ad-coder не нужен свой механизм: он
регистрирует хуки и тулы (`defineTool` / `AgentHarnessTool`).

## Что из этого следует для фаз

- Phase 0 работает через `pi-agent-core`; `pi-coding-agent` в зависимостях не нужен.
- `Role` — пресет над `AgentHarnessOptions`, свой агентный цикл не пишем.
- `Ledger` — атрибуция `Usage` по роли и шагу, с дельтами; арифметику денег не трогаем.
- Управление кэшем per-role достижимо без патчей апстрима. Произвольные
  брейкпоинты — только через `before_payload`, и в план это не берём.
- Слой плагинов = обёртка над `HookRegistry`, а не своя шина событий.

## Системный промт: полностью наш

`pi-agent-core/dist/harness/runtime/drive/generation.js:18`:

```js
async function resolveSystemPrompt(lane, context) {
  const config = lane.readConfig();
  if (config.systemPrompt === undefined) return "";
  if (typeof config.systemPrompt === "string") return config.systemPrompt;
  const source = config.toolContext;
  const toolContext = typeof source === "function" ? await source(context) : source;
  return config.systemPrompt(toolContext, context);
}
```

Конкатенации нет: строка уходит дословно, отсутствие промта даёт `""`, а не
дефолт харнесса. Окружение, AGENTS.md, скиллы не подмешиваются.

Описания тулов в системный промт не попадают — собираются отдельным массивом
(`generation.js:42-52`: `name`, `description`, `parameters`) и уезжают нативными
tool-params провайдера. «Малые промты» достижимы буквально.

Второй рубеж — хук `transform_context` подменяет `systemPrompt` перед отправкой
(`generation.js:118-124`), если промт надо собрать из бюджета в последний момент.

`systemPromptOverride` в `pi-coding-agent` существует потому, что там промт
собирается из ресурсов через `DefaultResourceLoader`. Этот слой мы не берём.

## Промты компакции — чужие. Компакцию Pi выключаем

`compaction.js:295` — `SUMMARIZATION_SYSTEM_PROMPT` жёсткая константа, читается
прямо в точках вызова (`compaction.js:402,548`,
`branch-summarization.js:158`), в конфиг не выносится. Экспортирована, но
подменить через конфиг нельзя.

Компакция тратит наши токены и решает, что доедет до следующего хода. Для
проекта с управлением контекстом во главе угла отдавать этот промт наружу нельзя.

**Решение:** `CompactionSettings.enabled: false`, своё сжатие в
`transform_context`. Тогда бюджет и стратегия целиком в ad-coder. Поднято в
Phase 1: если Phase 1 закрепит зависимость от стратегии Pi, Phase 2 будет её
выковыривать.

Полезное из Pi остаётся доступным как утилиты, даже с выключенной автокомпакцией:
`calculateContextTokens(usage)`, `getLastAssistantUsage(entries)`,
`estimateTokens`, `ContextUsageEstimate`.

**Не проверено:** срабатывает ли `before_payload` на запросах компакции. Для
решения выше неважно; понадобится, только если оставлять компакцию Pi и
переписывать её промт хирургией над payload.

## Поправки после Plan-прогона (LDO 2.42.0, run wf_01340a6b-0fd)

Планировщик перепроверил разведку установкой пакетов и нашёл два расхождения.

**`getModel` из корня `pi-ai` не существует.** Проба даёт
`typeof ai.getModel === "undefined"`, 0 вхождений в `dist/index.d.ts`. Символ
есть только в `@earendil-works/pi-ai/compat`, помечен
`@deprecated Static catalog read`, а шапка `compat.d.ts` говорит: «This module is
deleted with the coding-agent ModelManager migration». Пример
`import { getModel } from "@earendil-works/pi-ai"` в доке SDK самого Pi —
устаревший; я перенёс его в бриф не проверив.

Правильно: `getBuiltinModel` из `@earendil-works/pi-ai/providers/all` плюс
`createModels()`. Это и так требуется: `AgentHarnessOptions` хочет **и**
`model: Model<Api>`, **и** `models: Models`.

**`attempt` в `after_response` нет.** Событие несёт только
`{ status?, headers?, message }` плюс `lane` и `runId`. `attempt` живёт на
`before_request` (`agent-harness.d.ts:520`). Список измерений `Ledger` выше
исправлен. Нужна атрибуция стоимости ретраев — придётся протягивать номер
попытки хуком `before_request`; в Phase 0 не берём.

**Не проверяемо без живого вызова:** кумулятивен ли `usage` в `after_response`.
Предупреждение выше про кумулятивность относится к `message_update` — это другое
событие. В `.d.ts` семантика не зафиксирована. Решение: дельта-арифметика
остаётся чистой и тестируется синтетикой, а семантика прячется за один именованный
метод (`cumulativeUsageFrom`), переключаемый одной строкой после первого живого
прогона.

**Прочее, что стоит помнить** (из плана, проверено установкой):
`moduleResolution` обязан быть `"bundler"` — `.d.ts` Pi реэкспортируют с явными
расширениями `.ts`, и `node16`/`nodenext` их отвергают. Локальный node
v20.20.2 против `engines.node >=22.19.0` у `pi-agent-core` и `pi-telemetry` —
всё гонять через bun, node-скрипты в `package.json` не добавлять. Пины на
`0.85.1` точные, без каретки: Pi до 1.0 и движется быстро.

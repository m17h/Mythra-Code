/**
 * Trimmed copies of the providers' Markdown pricing pages as captured on
 * 2026-09-25, keeping the structure the parsers depend on: the anchor
 * headings, exact column names, link and footnote markup, annotated names,
 * "-" for unpublished components, and the Batch/Flex tables that must never
 * be read as standard rates.
 */

const OPENAI_HEADER = "| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |";

export const OPENAI_PRICING_PAGE = `# Pricing

> For the complete documentation index, see [llms.txt](/llms.txt).

Flagship models

Standard

### Standard pricing data

${OPENAI_HEADER}
| gpt-6-astra | $10.00 | $1.00 | $12.50 | $50.00 | $20.00 | $2.00 | $25.00 | $75.00 |
| gpt-6-sol | $2.00 | $0.20 | $2.50 | $10.00 | $4.00 | $0.40 | $5.00 | $15.00 |
| gpt-5.6-sol | $4.00 | $0.40 | $5.00 | $20.00 | $8.00 | $0.80 | $10.00 | $30.00 |
| gpt-5.5 (<272K context length) | $5.00 | $0.50 | - | $30.00 | $10.00 | $1.00 | - | $45.00 |
| gpt-5.5-pro (<272K context length) | $30.00 | - | - | $180.00 | $60.00 | - | - | $270.00 |
| gpt-4o-2024-05-13 | $5.00 | - | - | $15.00 | - | - | - | - |

Regional processing (data residency) endpoints are charged a 10% uplift.

Batch

### Batch pricing data

${OPENAI_HEADER}
| gpt-6-astra | $5.00 | $0.50 | $6.25 | $25.00 | $10.00 | $1.00 | $12.50 | $37.50 |
| gpt-6-sol | $1.00 | $0.10 | $1.25 | $5.00 | $2.00 | $0.20 | $2.50 | $7.50 |

Flex

### Flex pricing data

${OPENAI_HEADER}
| gpt-6-sol | $1.00 | $0.10 | $1.25 | $5.00 | $2.00 | $0.20 | $2.50 | $7.50 |

### Grouped Pricing Table data

| Category | Model | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| Codex | gpt-5.3-codex | $1.75 | $0.175 | $14.00 |
`;

const ANTHROPIC_HEADER = `| Model                                                                  | Base input tokens     | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens          |
| :--------------------------------------------------------------------- | :-------------------- | :-------------- | :-------------- | :----------------------- | :--------------------- |`;

export const ANTHROPIC_PRICING_PAGE = `---
title: Pricing
url: https://platform.claude.com/docs/en/about-claude/pricing
---

## Model pricing

The following table shows pricing for all Claude models:

${ANTHROPIC_HEADER}
| Claude Fable 5.1                                                       | $10 / MTok            | $12.50 / MTok   | $20 / MTok      | $0.25 / MTok<sup>1</sup> | $50 / MTok             |
| Claude Mythos 5.1 ([limited availability](https://anthropic.com/glasswing)) | $10 / MTok       | $12.50 / MTok   | $20 / MTok      | $0.25 / MTok<sup>1</sup> | $50 / MTok             |
| Claude Opus 5.5                                                        | $4 / MTok             | $5 / MTok       | $8 / MTok       | $0.20 / MTok<sup>2</sup> | $20 / MTok             |
| Claude Opus 4.1 ([retired, except on Bedrock and Google Cloud](https://platform.claude.com/docs/en/about-claude/model-deprecations)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Sonnet 5                                                        | $2 / MTok<sup>3</sup> | $2.50 / MTok    | $4 / MTok       | $0.20 / MTok             | $10 / MTok<sup>3</sup> |
| Claude Haiku 4.5                                                       | $1 / MTok             | $1.25 / MTok    | $2 / MTok       | $0.10 / MTok             | $5 / MTok              |
| Claude Haiku 3.5 ([retired, except on Bedrock and Google Cloud](https://platform.claude.com/docs/en/about-claude/model-deprecations)) | $0.80 / MTok | $1 / MTok | $1.60 / MTok | $0.08 / MTok | $4 / MTok |

*<sup>1 Cache hits and refreshes on Claude Fable 5.1 are priced at 0.025x the base input price.</sup>*

### Batch processing

| Model           | Batch input  | Batch output  |
| :-------------- | :----------- | :------------ |
| Claude Opus 5.5 | $2 / MTok    | $10 / MTok    |
`;

const CURSOR_HEADER = `| Model                                         | Provider  | Input | Cache write | Cache read | Output | Notes |
| --------------------------------------------- | --------- | ----- | ----------- | ---------- | ------ | ----- |`;

export const CURSOR_PRICING_PAGE = `# Models & Pricing

## Cursor Models

The Cursor Models pool includes Grok 4.5 and Composer 2.5.

${CURSOR_HEADER}
| Grok 4.5                                      | Cursor    | $2    | -           | $0.5       | $6     | Jointly trained by Cursor and SpaceXAI |
| Grok 4.5 (Fast)                               | Cursor    | $4    | -           | $1         | $18    | Jointly trained by Cursor and SpaceXAI |
| [Composer 2.5](https://cursor.com/blog/composer-2-5) | Cursor | $0.5 | -        | $0.2       | $2.5   | - |

## Other Models

### Model pricing

All prices are per million tokens:

${CURSOR_HEADER}
| [Claude 4.6 Opus](https://www.anthropic.com/claude/opus)     | Anthropic | $5    | $6.25       | $0.5       | $25    | Hidden by default; Fast mode (\\\`claude-opus-4-6-fast\\\`) \\| Max Mode |
| [Claude Opus 5.5](https://www.anthropic.com/claude/opus)     | Anthropic | $4    | $5          | $0.2       | $20    | Requires Max Mode on legacy request-based plans |
| [GPT-5.6 Sol](https://openai.com/index/previewing-gpt-5-6-sol/) | OpenAI | $4    | $5          | $0.4       | $20    | Requires Max Mode on legacy request-based plans |
| [Kimi K3](https://www.moonshot.ai)                           | Moonshot  | $3    | -           | $0.3       | $15    | No separate cache-write fee |

## Cursor Token Rate

On Teams and Enterprise plans, third-party model requests include a Cursor Token Rate of $0.25 per million tokens.
`;

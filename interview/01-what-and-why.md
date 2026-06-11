# 01 — What is SentinelAI and Why Does It Exist?

Start here. This doc explains the problem from scratch, like you've never heard of AI APIs before.

---

## First: What is an LLM?

An LLM (Large Language Model) is a type of AI that is really good at understanding and generating text. ChatGPT, Claude, and Gemini are all LLMs. You send them a message (called a **prompt**), and they send back a response.

Under the hood, companies like OpenAI, Anthropic, and Google have trained these models on massive amounts of text and hosted them on powerful servers. You access them by calling their **API** — essentially sending an HTTP request to their servers and getting a text response back.

Simple example:
```
You send:  "What is the capital of France?"
LLM sends: "The capital of France is Paris."
```

---

## The Problem: Direct API Calls Work Fine for One App

If you're building a single chatbot, the simplest thing to do is call the OpenAI API directly from your app:

```
Your App → OpenAI API → Response
```

This works. For a demo or personal project, it's fine. Most tutorials show exactly this.

---

## The Problem Gets Real at Companies

Imagine a company with 5 different AI-powered products:

- An HR chatbot that answers employee questions
- A customer support bot on the website
- A sales assistant that helps write proposals
- An engineering docs search tool
- A legal document summarizer

Without a gateway, each team builds their own version of the same plumbing:

| Thing every team re-builds | Why it's annoying |
|---|---|
| API key management | Each team stores their own key, rotations are a nightmare |
| Rate limiting | If one bot gets spammed, it eats the company's quota |
| Error handling and retries | Every team writes slightly different retry logic |
| Logging | No consistent way to see "how much are we spending on AI?" |
| Security | Some teams add prompt injection protection, some don't |
| Cost tracking | Finance has no idea which team is spending what |

This is the same problem that existed with HTTP APIs before API gateways like Kong and Nginx became standard. The solution there was: put a proxy in front of all traffic. The same pattern applies to LLM traffic.

---

## The Solution: A Gateway

A gateway is a **single entry point** for all AI traffic. Every request goes through it before reaching the LLM provider.

```
App 1 ─┐
App 2 ─┼─→ SentinelAI Gateway ─→ OpenAI / Anthropic / Groq / etc.
App 3 ─┘
```

The gateway can now handle — once, for everyone — all the things every team was duplicating:

- **Auth:** which app is allowed to call which model?
- **Rate limiting:** don't let one app starve the others
- **Cost tracking:** record tokens and cost per request, per tenant
- **Security:** check every prompt for injection attacks or sensitive data before it leaves the company
- **Observability:** log every request with its model, latency, cost, and outcome
- **Retries:** if OpenAI returns a 429 (rate limited), retry with backoff automatically
- **Fallback:** if Anthropic is down, automatically switch to Groq
- **Caching:** if two apps ask the same question, return the cached answer instead of paying for a second LLM call

---

## What SentinelAI Is

SentinelAI is a **self-hosted** version of this gateway. "Self-hosted" means you run it on your own server (a DigitalOcean droplet in this case) rather than using a paid cloud service.

It does everything listed above, plus:

- **RAG:** lets your apps search through company documents before answering questions
- **Agents:** lets your apps run multi-step AI workflows that can use tools (search, calculator, database queries)
- **Eval worker:** automatically scores every response for quality and hallucination
- **Conversation memory:** remembers what was said across multiple messages in a session

---

## Why Build This as a Portfolio Project?

The AI industry right now is not just "call OpenAI and build a chatbot." Companies building real production AI systems need exactly this kind of infrastructure. The job titles are things like:

- AI Platform Engineer
- LLM Infra Engineer
- Backend Engineer, AI Systems
- MLOps Engineer

These roles want people who understand:
- How to build reliable backend systems
- How AI models work at the API level (not training, just calling and managing them)
- How to observe, secure, and operate AI in production

SentinelAI demonstrates all of these things in one project. It's not "I called OpenAI" — it's "I built the infrastructure layer that sits in front of OpenAI."

---

## Real Companies That Do This

| Company | Product | What it does |
|---|---|---|
| Helicone | helicone.ai | Hosted AI gateway, proxy for LLM calls |
| Portkey | portkey.ai | Multi-provider routing, observability |
| LangSmith | LangChain's product | Tracing and eval for LLM apps |
| Kong | Kong AI Gateway | Enterprise AI traffic management |
| Braintrust | braintrustdata.com | Eval and logging for LLMs |

SentinelAI is a self-built version of what these companies sell. Building it yourself shows you understand the problem deeply, not just that you know how to sign up for a SaaS product.

---

## Summary

- LLMs are text AI models accessed via API
- Calling them directly from each app works for demos but breaks down at scale
- A gateway solves this: one entry point, shared auth/logging/security/routing for all apps
- SentinelAI is a self-hosted gateway with routing, RAG, agents, observability, and eval
- The target audience for this project on a resume is AI infra / backend platform engineering roles

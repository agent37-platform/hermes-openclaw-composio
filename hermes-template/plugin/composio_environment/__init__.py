from __future__ import annotations

from .prompt import inject_prompt_context


def register(ctx) -> None:
    ctx.register_hook("pre_llm_call", inject_prompt_context)

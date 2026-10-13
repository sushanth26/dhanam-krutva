import time
from typing import Any


def cache_put(cache: dict[Any, tuple[float, Any]], key: Any, value: Any, max_age: float, max_items: int) -> None:
    """Store (now, value) and evict: entries older than max_age, then the oldest beyond max_items.

    The in-process caches used to keep every entry until a restart, so RAM (Railway's main cost) crept up.
    """
    now = time.time()
    cache[key] = (now, value)
    for stale in [k for k, (at, _) in cache.items() if now - at > max_age]:
        del cache[stale]
    if len(cache) > max_items:
        for old in sorted(cache, key=lambda k: cache[k][0])[: len(cache) - max_items]:
            del cache[old]

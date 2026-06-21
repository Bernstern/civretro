"""
Logging setup for the civretro package.

All modules should call get_logger(__name__) to obtain a logger.
Call configure_logging() once at each CLI entry point.

Environment variables:
  CIVRETRO_LOG_LEVEL  — log level name (default: INFO)
  CIVRETRO_LOG_JSON   — set to 1/true/yes to emit JSON lines to stderr
"""

import json
import logging
import os
import sys


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": int(record.created * 1000),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        # Include any extra fields set via logger.info("msg", extra={...})
        for key, val in record.__dict__.items():
            if key not in ("name", "msg", "args", "levelname", "levelno", "pathname",
                           "filename", "module", "exc_info", "exc_text", "stack_info",
                           "lineno", "funcName", "created", "msecs", "relativeCreated",
                           "thread", "threadName", "processName", "process", "message",
                           "taskName"):
                entry[key] = val
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry)


def configure_logging() -> None:
    level_name = os.environ.get("CIVRETRO_LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    use_json = os.environ.get("CIVRETRO_LOG_JSON", "").lower() in ("1", "true", "yes")

    handler = logging.StreamHandler(sys.stderr)
    if use_json:
        handler.setFormatter(_JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter(
            fmt="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
            datefmt="%H:%M:%S",
        ))

    root = logging.getLogger()
    root.setLevel(level)
    root.handlers.clear()
    root.addHandler(handler)

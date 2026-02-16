import json
import logging
import os
import re
from datetime import datetime, timezone, timedelta

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

S3_BUCKET = os.environ.get("S3_BUCKET", "kp-dev-s3-data")
S3_PREFIX = os.environ.get("S3_PREFIX", "knowledge/")
KNOWLEDGE_BASE_ID = os.environ.get("KNOWLEDGE_BASE_ID", "")
DATA_SOURCE_ID = os.environ.get("DATA_SOURCE_ID", "")

s3 = boto3.client("s3")
bedrock_agent = boto3.client("bedrock-agent")

JST = timezone(timedelta(hours=9))


def lambda_handler(event, context):
    """API Gateway proxy integration handler."""
    try:
        body = json.loads(event.get("body", "{}"))
    except json.JSONDecodeError:
        return _response(400, {"error": "Invalid JSON"})

    action = body.get("action")
    items = body.get("items", [])

    if action not in ("add", "update", "delete"):
        return _response(400, {"error": f"Invalid action: {action}"})

    if not items:
        return _response(400, {"error": "No items provided"})

    handler = {"add": _handle_add, "update": _handle_update, "delete": _handle_delete}
    results = handler[action](items)

    _start_kb_sync()

    return _response(200, {"results": results})


# ---------------------------------------------------------------------------
# Action handlers
# ---------------------------------------------------------------------------


def _handle_add(items):
    results = []
    for item in items:
        result = _validate_item(item)
        if result:
            results.append(result)
            continue

        no = item["no"]
        try:
            md_content = _to_markdown(item["question"], item["answer"])
            metadata = _build_metadata(item)

            s3.put_object(
                Bucket=S3_BUCKET,
                Key=f"{S3_PREFIX}{no}.md",
                Body=md_content.encode("utf-8"),
                ContentType="text/markdown; charset=utf-8",
            )
            s3.put_object(
                Bucket=S3_BUCKET,
                Key=f"{S3_PREFIX}{no}.metadata.json",
                Body=json.dumps(metadata, ensure_ascii=False).encode("utf-8"),
                ContentType="application/json",
            )

            results.append(_success_result(no))
        except Exception as e:
            logger.error("Failed to add %s: %s", no, e)
            results.append(_error_result(no, str(e)))

    return results


def _handle_update(items):
    results = []
    for item in items:
        result = _validate_item(item)
        if result:
            results.append(result)
            continue

        no = item["no"]
        try:
            md_content = _to_markdown(item["question"], item["answer"])
            metadata = _build_metadata(item)

            s3.put_object(
                Bucket=S3_BUCKET,
                Key=f"{S3_PREFIX}{no}.md",
                Body=md_content.encode("utf-8"),
                ContentType="text/markdown; charset=utf-8",
            )
            s3.put_object(
                Bucket=S3_BUCKET,
                Key=f"{S3_PREFIX}{no}.metadata.json",
                Body=json.dumps(metadata, ensure_ascii=False).encode("utf-8"),
                ContentType="application/json",
            )

            results.append(_success_result(no))
        except Exception as e:
            logger.error("Failed to update %s: %s", no, e)
            results.append(_error_result(no, str(e)))

    return results


def _handle_delete(items):
    results = []
    for item in items:
        no = item.get("no")
        if not no:
            results.append(_error_result("unknown", "Missing 'no' field"))
            continue

        try:
            s3.delete_object(Bucket=S3_BUCKET, Key=f"{S3_PREFIX}{no}.md")
            s3.delete_object(Bucket=S3_BUCKET, Key=f"{S3_PREFIX}{no}.metadata.json")
            results.append(_success_result(no, message="Deleted"))
        except Exception as e:
            logger.error("Failed to delete %s: %s", no, e)
            results.append(_error_result(no, str(e)))

    return results


# ---------------------------------------------------------------------------
# Markdown conversion
# ---------------------------------------------------------------------------


def _to_markdown(question, answer):
    """Convert natural language Q&A to Markdown format.

    - Question becomes an H1 heading.
    - Answer is normalized: collapse excessive blank lines into paragraph breaks.
    """
    q = question.strip()
    a = _normalize_text(answer.strip())
    return f"# {q}\n\n{a}\n"


def _normalize_text(text):
    """Normalize whitespace in answer text.

    - Replace Windows line endings.
    - Collapse 3+ consecutive newlines into 2 (paragraph separator).
    - Strip trailing whitespace per line.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    lines = [line.rstrip() for line in text.split("\n")]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Metadata
# ---------------------------------------------------------------------------


def _build_metadata(item):
    """Build Knowledge Bases S3 metadata file content."""
    now = datetime.now(JST).isoformat(timespec="seconds")
    return {
        "metadataAttributes": {
            "no": item["no"],
            "category": item.get("category", ""),
            "source_url": item.get("source_url", ""),
            "updated_at": now,
        }
    }


# ---------------------------------------------------------------------------
# Knowledge Base sync
# ---------------------------------------------------------------------------


def _start_kb_sync():
    """Trigger a Knowledge Bases ingestion job (once per invocation)."""
    if not KNOWLEDGE_BASE_ID or not DATA_SOURCE_ID:
        logger.warning("KNOWLEDGE_BASE_ID or DATA_SOURCE_ID not set; skipping sync")
        return

    try:
        bedrock_agent.start_ingestion_job(
            knowledgeBaseId=KNOWLEDGE_BASE_ID,
            dataSourceId=DATA_SOURCE_ID,
        )
        logger.info("Started KB ingestion job")
    except Exception as e:
        logger.error("Failed to start KB ingestion: %s", e)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _validate_item(item):
    """Return an error result dict if the item is invalid, else None."""
    no = item.get("no")
    if not no:
        return _error_result("unknown", "Missing 'no' field")
    if not item.get("question"):
        return _error_result(no, "Missing 'question' field")
    if not item.get("answer"):
        return _error_result(no, "Missing 'answer' field")
    return None


def _success_result(no, message="Success"):
    now = datetime.now(JST).isoformat(timespec="seconds")
    return {"no": no, "status": "success", "message": message, "updated_at": now}


def _error_result(no, message):
    return {"no": no, "status": "error", "message": message, "updated_at": None}


def _response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": json.dumps(body, ensure_ascii=False),
    }

# -*- coding: utf-8 -*-
"""
通过 GitHub REST API 发布仓库（不走 git push，因为到 github.com 的 POST 被阻断，
而 api.github.com 可用）。

用法：
    set GITHUB_TOKEN=ghp_xxx   (bash: export GITHUB_TOKEN=ghp_xxx)
    python publish_github.py [repo_name]
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = "https://api.github.com"
REPO_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.join(REPO_DIR, "..")
PROJECT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

# 只传这些（排除 .git / data / node_modules）
INCLUDE_DIRS = ("src", "public", "test", "demo", "fixtures", "shots")
INCLUDE_FILES = ("README.md", "package.json", "LICENSE", ".gitignore")
TEXT_EXT = {".js", ".json", ".md", ".html", ".css", ".txt", ""}
BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp"}


def call(method, path, token, payload=None):
    url = API + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "intentguard-publisher")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read()
            return r.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "ignore")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"raw": body}


def collect():
    out = []
    for f in INCLUDE_FILES:
        p = os.path.join(PROJECT, f)
        if os.path.isfile(p):
            out.append(f)
    for d in INCLUDE_DIRS:
        base = os.path.join(PROJECT, d)
        for root, _, files in os.walk(base):
            for name in files:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, PROJECT).replace("\\", "/")
                out.append(rel)
    return sorted(set(out))


def main():
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if not token:
        print("ERROR: 请先设置 GITHUB_TOKEN 环境变量")
        return 1
    name = sys.argv[1] if len(sys.argv) > 1 else "intentguard"

    status, me = call("GET", "/user", token)
    if status != 200:
        print("认证失败:", status, me)
        return 1
    owner = me["login"]
    print(f"认证成功: {owner}")

    # 建仓（已存在则复用）
    status, repo = call("POST", "/user/repos", token, {
        "name": name,
        "description": "Policy-gated payment rail for AI agents, built on NEAR Intents",
        "private": False,
        "has_issues": True,
        "has_wiki": False,
    })
    if status == 201:
        print("仓库已创建:", repo["html_url"])
    elif status == 422:
        print("仓库已存在，复用")
        status, repo = call("GET", f"/repos/{owner}/{name}", token)
        if status != 200:
            print("读取仓库失败", status, repo)
            return 1
    else:
        print("建仓失败:", status, repo)
        return 1

    branch = repo.get("default_branch") or "main"
    files = collect()
    print(f"待上传 {len(files)} 个文件，分支 {branch}")

    ok = fail = 0
    for rel in files:
        full = os.path.join(PROJECT, rel)
        raw = open(full, "rb").read()
        payload = {
            "message": f"Add {rel}",
            "content": base64.b64encode(raw).decode(),
            "branch": branch,
        }
        status, res = call("PUT", f"/repos/{owner}/{name}/contents/{rel}", token, payload)
        if status in (200, 201):
            ok += 1
            print(f"  ok  {rel}")
        else:
            fail += 1
            print(f"  ERR {rel} -> {status} {str(res)[:120]}")
        time.sleep(0.25)

    print(f"\n完成：成功 {ok}，失败 {fail}")
    print("仓库地址:", repo["html_url"])
    return 0 if fail == 0 else 2


if __name__ == "__main__":
    sys.exit(main())

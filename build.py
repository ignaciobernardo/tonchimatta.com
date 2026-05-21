#!/usr/bin/env python3
"""Encrypts the protected portion of index.source.html with a password.

Reads index.source.html, encrypts the content inside the
<!-- BUILD:PROTECTED_START --> ... <!-- BUILD:PROTECTED_END --> markers
using AES-256-GCM with a PBKDF2-derived key from PASSWORD, and writes
index.html (the file served by GitHub Pages).

The deployed index.html contains only the lock screen UI plus an
encrypted blob. Without the correct password, the rest of the site
cannot be read or rendered — deleting the lock screen div does nothing
because the actual content is not in the DOM.

Workflow:
  1. Edit index.source.html as usual.
  2. Run: python3 build.py
  3. git add index.html index.source.html && git commit && git push

Requires: cryptography (pip3 install --user --break-system-packages cryptography)
"""

import base64
import json
import re
import secrets
import sys
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

PASSWORD = "181025"
SOURCE = "index.source.html"
OUTPUT = "index.html"
PHOTOS_DATA = "photos_data.js"
PBKDF2_ITERATIONS = 250_000

ROOT = Path(__file__).resolve().parent


def build():
    src_path = ROOT / SOURCE
    if not src_path.exists():
        sys.exit(f"ERROR: {SOURCE} not found")
    src = src_path.read_text(encoding="utf-8")

    protected_match = re.search(
        r"<!-- BUILD:PROTECTED_START -->(.*?)<!-- BUILD:PROTECTED_END -->",
        src,
        re.DOTALL,
    )
    if not protected_match:
        sys.exit("ERROR: BUILD:PROTECTED markers not found in source")
    protected = protected_match.group(1)

    photos_path = ROOT / PHOTOS_DATA
    if photos_path.exists():
        photos_js = photos_path.read_text(encoding="utf-8")
        new_protected, n = re.subn(
            r'<script\s+src=["\']photos_data\.js["\']\s*></script>',
            "<script>\n" + photos_js + "\n</script>",
            protected,
        )
        if n > 0:
            protected = new_protected
            print(f"  inlined {PHOTOS_DATA} ({len(photos_js):,} bytes)")

    public_html = re.sub(
        r"<!-- BUILD:LOCK_SCRIPT_START -->.*?<!-- BUILD:LOCK_SCRIPT_END -->",
        "__LOCK_SCRIPT_SLOT__",
        src,
        count=1,
        flags=re.DOTALL,
    )
    public_html = re.sub(
        r"\s*<!-- BUILD:PROTECTED_START -->.*?<!-- BUILD:PROTECTED_END -->\s*",
        "\n",
        public_html,
        count=1,
        flags=re.DOTALL,
    )

    salt = secrets.token_bytes(16)
    nonce = secrets.token_bytes(12)
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    key = kdf.derive(PASSWORD.encode("utf-8"))
    ciphertext = AESGCM(key).encrypt(nonce, protected.encode("utf-8"), None)

    payload = {
        "v": 1,
        "kdf": "PBKDF2-SHA256",
        "iter": PBKDF2_ITERATIONS,
        "cipher": "AES-GCM",
        "salt": base64.b64encode(salt).decode("ascii"),
        "nonce": base64.b64encode(nonce).decode("ascii"),
        "ct": base64.b64encode(ciphertext).decode("ascii"),
    }

    prod_script = (
        '<script id="payload" type="application/json">'
        + json.dumps(payload, separators=(",", ":"))
        + "</script>\n"
        + RUNTIME_SCRIPT
    )

    output = public_html.replace("__LOCK_SCRIPT_SLOT__", prod_script)

    (ROOT / OUTPUT).write_text(output, encoding="utf-8")
    print(
        f"  wrote {OUTPUT} ({len(output):,} bytes total, "
        f"{len(ciphertext):,} bytes ciphertext)"
    )


RUNTIME_SCRIPT = r"""<script>
  (function () {
    var SESSION_KEY = "tm_unlocked_v2";
    var lockScreen = document.getElementById("lock-screen");
    var form = document.getElementById("lock-form");
    var input = document.getElementById("lock-password");
    var hint = document.getElementById("lock-hint");
    var timeEl = document.getElementById("lock-time");
    var dateEl = document.getElementById("lock-date");
    var payload = JSON.parse(document.getElementById("payload").textContent);

    function pad(n) { return n < 10 ? "0" + n : "" + n; }
    function updateClock() {
      var now = new Date();
      timeEl.textContent = pad(now.getHours()) + ":" + pad(now.getMinutes());
      var days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
      var months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
      dateEl.textContent = days[now.getDay()] + ", " + months[now.getMonth()] + " " + now.getDate();
    }
    updateClock();
    setInterval(updateClock, 1000);

    function b64ToBytes(b64) {
      var bin = atob(b64);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }

    function deriveKey(password) {
      var enc = new TextEncoder();
      return crypto.subtle.importKey(
        "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]
      ).then(function (baseKey) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: b64ToBytes(payload.salt), iterations: payload.iter, hash: "SHA-256" },
          baseKey,
          { name: "AES-GCM", length: 256 },
          false,
          ["decrypt"]
        );
      });
    }

    function decrypt(password) {
      return deriveKey(password).then(function (key) {
        return crypto.subtle.decrypt(
          { name: "AES-GCM", iv: b64ToBytes(payload.nonce) },
          key,
          b64ToBytes(payload.ct)
        );
      }).then(function (plainBuf) {
        return new TextDecoder("utf-8").decode(plainBuf);
      });
    }

    function injectAndRun(html) {
      var container = document.createElement("template");
      container.innerHTML = html;
      var nodes = Array.prototype.slice.call(container.content.childNodes);
      nodes.forEach(function (node) {
        if (node.nodeName === "SCRIPT") {
          var s = document.createElement("script");
          for (var i = 0; i < node.attributes.length; i++) {
            s.setAttribute(node.attributes[i].name, node.attributes[i].value);
          }
          s.text = node.textContent;
          document.body.appendChild(s);
        } else {
          document.body.appendChild(node.cloneNode(true));
        }
      });
    }

    function finishUnlock(html, cache) {
      if (cache) {
        try { sessionStorage.setItem(SESSION_KEY, html); } catch (e) {}
      }
      injectAndRun(html);
      lockScreen.classList.add("unlocking");
      setTimeout(function () {
        if (lockScreen.parentNode) lockScreen.parentNode.removeChild(lockScreen);
      }, 480);
    }

    try {
      var cached = sessionStorage.getItem(SESSION_KEY);
      if (cached) {
        finishUnlock(cached, false);
        return;
      }
    } catch (e) {}

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      hint.classList.remove("error");
      hint.textContent = "Unlocking...";
      decrypt(input.value).then(function (html) {
        finishUnlock(html, true);
      }).catch(function () {
        hint.textContent = "Incorrect password. Try again.";
        hint.classList.add("error");
        form.classList.remove("shake");
        void form.offsetWidth;
        form.classList.add("shake");
        input.value = "";
        input.focus();
      });
    });

    setTimeout(function () { input.focus(); }, 50);
  })();
</script>"""


if __name__ == "__main__":
    print(f"Building {OUTPUT} from {SOURCE}...")
    build()
    print("Done.")

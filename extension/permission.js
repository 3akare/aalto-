/**
 * One-time microphone permission grant.
 *
 * An offscreen document can USE the microphone but cannot prompt for it, and the
 * popup closes the moment it loses focus - which is exactly what happens when
 * Chrome's permission bubble appears. So the prompt has to come from an ordinary
 * extension page. Permission is granted to the extension's origin, so once this
 * page succeeds the offscreen recorder works from then on.
 */

const grantBtn = document.getElementById("grant");
const statusEl = document.getElementById("status");

grantBtn.addEventListener("click", async () => {
  grantBtn.disabled = true;
  statusEl.textContent = "Waiting for Chrome's permission prompt…";
  statusEl.className = "";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // We only needed the grant; release the device immediately so no tab sits
    // holding the microphone open.
    for (const track of stream.getTracks()) track.stop();

    statusEl.className = "ok";
    statusEl.textContent = "Microphone enabled. You can close this tab and use Aalto.";
    grantBtn.textContent = "Done";
  } catch (err) {
    grantBtn.disabled = false;
    statusEl.className = "bad";
    statusEl.innerHTML = explain(err);
  }
});

function explain(err) {
  const name = err?.name ?? "";
  if (name === "NotAllowedError" || /denied|dismiss/i.test(err?.message ?? "")) {
    return `
      Chrome blocked the microphone. To undo that:
      <ol>
        <li>Click the icon at the left of the address bar (a slider or a lock).</li>
        <li>Set <strong>Microphone</strong> to <strong>Allow</strong>.</li>
        <li>Reload this page and press the button again.</li>
      </ol>
      If there is no microphone entry there, open
      <code>chrome://settings/content/microphone</code> and remove Aalto from the
      blocked list.
    `;
  }
  if (name === "NotFoundError") {
    return "No microphone found. Plug one in, then press the button again.";
  }
  if (name === "NotReadableError") {
    return "Your microphone is in use by another app. Close it and try again.";
  }
  return `Could not enable the microphone: ${err?.message ?? err}`;
}

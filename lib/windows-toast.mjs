/**
 * Windows fallback notification: a WinRT toast first, a tray balloon second.
 *
 * The PowerShell payload is passed as an encoded command, and the title/body as
 * base64 environment variables, so Chinese text and quotes never pass through a
 * command line. Success is reported by the script's `TOAST_OK` / `BALLOON_OK`
 * marker.
 */
import { spawn } from 'node:child_process';

export const DEFAULT_APP_ID =
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const SCRIPT = String.raw`
$ErrorActionPreference = 'Continue'
$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DSHQQ_TITLE))
$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DSHQQ_BODY))
$appId = $env:DSHQQ_APPID
$result = 'NONE'
try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $escTitle = [System.Security.SecurityElement]::Escape($title)
  $escBody = [System.Security.SecurityElement]::Escape($body)
  $xmlText = '<toast activationType="foreground" scenario="default"><visual><binding template="ToastGeneric"><text>' + $escTitle + '</text><text>' + $escBody + '</text></binding></visual><audio src="ms-winsoundevent:Notification.Default" /></toast>'
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($xmlText)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
  $notifier.Show($toast)
  $result = 'TOAST_OK'
}
catch {
  Write-Output ('TOAST_FAIL: ' + $_.Exception.Message)
}
if ($result -eq 'NONE') {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $ni = New-Object System.Windows.Forms.NotifyIcon
    $ni.Icon = [System.Drawing.SystemIcons]::Information
    $ni.BalloonTipTitle = $title
    $ni.BalloonTipText = $body
    $ni.Visible = $true
    $ni.ShowBalloonTip(8000)
    Start-Sleep -Milliseconds 2600
    $ni.Dispose()
    $result = 'BALLOON_OK'
  }
  catch {
    Write-Output ('BALLOON_FAIL: ' + $_.Exception.Message)
    $result = 'BALLOON_FAIL'
  }
}
Write-Output $result
if ($result -eq 'TOAST_OK' -or $result -eq 'BALLOON_OK') { exit 0 } else { exit 1 }
`;

function encodeUtf8Base64(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('base64');
}

/**
 * @param {{title?: string, body: string, timeoutMs?: number, appId?: string}} options
 * @returns {Promise<{ok: boolean, via: 'toast'|'balloon'|'timeout'|'failed', detail: string}>}
 */
export function showWindowsNotification(options = {}) {
  const title = String(options.title ?? 'DSH 权限申请');
  const body = String(options.body ?? '');
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 12000;
  const appId = typeof options.appId === 'string' && options.appId.trim() ? options.appId.trim() : DEFAULT_APP_ID;
  const encodedCommand = Buffer.from(SCRIPT, 'utf16le').toString('base64');

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encodedCommand,
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DSHQQ_TITLE: encodeUtf8Base64(title),
          DSHQQ_BODY: encodeUtf8Base64(body),
          DSHQQ_APPID: appId,
        },
      });
    } catch (error) {
      resolve({ ok: false, via: 'failed', detail: `无法启动 PowerShell：${error.message}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ ok: false, via: 'timeout', detail: `Windows 通知超时（${timeoutMs}ms）` });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ ok: false, via: 'failed', detail: `无法启动 PowerShell：${error.message}` }));
    child.on('close', (code) => {
      if (stdout.includes('TOAST_OK')) {
        finish({ ok: true, via: 'toast', detail: 'toast' });
        return;
      }
      if (stdout.includes('BALLOON_OK')) {
        finish({ ok: true, via: 'balloon', detail: 'balloon' });
        return;
      }
      const failure = stdout.split(/\r?\n/).filter((line) => /_FAIL|FAIL:/.test(line)).join(' | ');
      const detail = failure || stderr.trim().split(/\r?\n/).slice(-3).join(' | ') || `PowerShell 退出码 ${code}`;
      finish({ ok: false, via: 'failed', detail: detail.slice(0, 300) });
    });
  });
}

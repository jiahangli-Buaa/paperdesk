"""Collect the Windows installed-app checks without bundling user data."""
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
destination = ROOT / 'release/windows-x64/Paperdesk-Windows-Test-Kit'
(destination / 'scripts').mkdir(parents=True, exist_ok=True)
for name in ('smoke-desktop.cjs', 'smoke-browsers.cjs', 'smoke-credentials.py'):
    shutil.copy2(ROOT / 'scripts' / name, destination / 'scripts' / name)
shutil.copy2(ROOT / 'scripts/Run-Installed-App-Checks.ps1', destination / 'Run-Installed-App-Checks.ps1')
(destination / 'README.txt').write_text(
    'Paperdesk Windows installed-app checks\n\n'
    'Install Paperdesk, then run in PowerShell:\n'
    '.\\Run-Installed-App-Checks.ps1 -AppDir "C:\\path\\to\\Paperdesk"\n\n'
    'The checks use the installed Python, Node and Playwright with temporary data.\n'
    'They test DPAPI, Chromium, Firefox, onboarding, records, backup/restore,\n'
    'background operation and relaunch. Results are written to build/test-results.\n'
    'Installation, shortcuts, tray interaction, overwrite installation and uninstall\n'
    'also need direct checks on the Windows machine.\n', encoding='utf-8')
archive = destination.with_suffix('.zip')
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
    for relative in ('README.txt', 'Run-Installed-App-Checks.ps1',
                     'scripts/smoke-desktop.cjs', 'scripts/smoke-browsers.cjs',
                     'scripts/smoke-credentials.py'):
        bundle.write(destination / relative, f'{destination.name}/{relative}')
print(archive)

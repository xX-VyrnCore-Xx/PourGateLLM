; Stops PourGateLLM and its bundled gateway before an install, update or uninstall touches the files.
; A running node.exe in the install folder would otherwise keep it locked and block the uninstaller.
!macro PG_STOP_PROCESSES
  nsExec::Exec "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command $\"Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR', [System.StringComparison]::OrdinalIgnoreCase) -and $$_.Name -notlike 'uninstall*' -and $$_.ProcessId -ne $$PID } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }$\""
  Sleep 1000
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro PG_STOP_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro PG_STOP_PROCESSES
!macroend

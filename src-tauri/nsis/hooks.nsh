; Remove only this installation's opt-in startup entry on a real uninstall.
; Keep it on Tauri updates, and never touch another install's registration.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    Push $R0
    ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Pi Launcher"
    ${If} $R0 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\"'
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Pi Launcher"
    ${EndIf}
    Pop $R0
  ${EndIf}
!macroend

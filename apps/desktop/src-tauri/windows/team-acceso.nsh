; Acceso directo «Lixbon Team» en el instalador NSIS (el .exe): el mismo
; ejecutable con --team, que abre solo la ventana de Team.
!macro NSIS_HOOK_POSTINSTALL
  CreateShortcut "$SMPROGRAMS\Lixbon Team.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "--team" "$INSTDIR\${MAINBINARYNAME}.exe" 0
  CreateShortcut "$DESKTOP\Lixbon Team.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "--team" "$INSTDIR\${MAINBINARYNAME}.exe" 0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$SMPROGRAMS\Lixbon Team.lnk"
  Delete "$DESKTOP\Lixbon Team.lnk"
!macroend

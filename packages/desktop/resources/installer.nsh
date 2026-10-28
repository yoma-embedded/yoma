!macro customPageAfterChangeDir
  !include nsDialogs.nsh
  Var yomaShortcutChoice
  Var yomaShortcutCheckbox
  Var yomaShortcutTitle
  Var yomaShortcutText
  Page custom yomaShortcutPage yomaShortcutLeave

  Function yomaShortcutPage
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    StrCpy $yomaShortcutTitle "Shortcuts"
    StrCpy $yomaShortcutText "Create a desktop shortcut"
    ${If} $LANGUAGE == 2052
      StrCpy $yomaShortcutTitle "快捷方式"
      StrCpy $yomaShortcutText "创建桌面快捷方式"
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "$yomaShortcutTitle" "$yomaShortcutText"
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateCheckbox} 0 12u 100% 12u "$yomaShortcutText"
    Pop $yomaShortcutCheckbox
    StrCpy $yomaShortcutChoice ${BST_CHECKED}
    ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 != ""
      !insertmacro setLinkVars
      ${IfNot} ${FileExists} "$oldDesktopLink"
        StrCpy $yomaShortcutChoice ${BST_UNCHECKED}
      ${EndIf}
    ${EndIf}
    ${NSD_SetState} $yomaShortcutCheckbox $yomaShortcutChoice
    nsDialogs::Show
  FunctionEnd

  Function yomaShortcutLeave
    ${NSD_GetState} $yomaShortcutCheckbox $yomaShortcutChoice
  FunctionEnd
!macroend

!macro customInstall
  ; Silent updates keep electron-builder's existing shortcut behavior.
  ${If} $yomaShortcutChoice != ""
    ${If} $yomaShortcutChoice == ${BST_UNCHECKED}
      Delete "$newDesktopLink"
    ${Else}
      ${IfNot} ${isNoDesktopShortcut}
        CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
        WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  SetDetailsView show
  DetailPrint "正在下载 Paperdesk 投稿读取组件，请保持网络连接。"
  paperdesk_download_retry:
  nsExec::ExecToLog '"$INSTDIR\resources\runtime\node\node.exe" "$INSTDIR\resources\src\desktop\install-components.cjs" "$LOCALAPPDATA\Paperdesk\components" --text'
  Pop $0
  ${If} $0 != 0
    IfSilent paperdesk_download_cancel
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "组件下载未完成。请检查网络后重试，已完成的组件会保留。" IDRETRY paperdesk_download_retry
    paperdesk_download_cancel:
    SetErrorLevel 1
    Abort "Paperdesk 组件下载未完成。重新运行安装程序可继续。"
  ${EndIf}
  DetailPrint "Paperdesk 投稿读取组件已就绪。"
!macroend

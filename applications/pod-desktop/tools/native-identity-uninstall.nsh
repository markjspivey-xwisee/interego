; Remove only this user's Interego browser registration. Preserve pod and key data.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    ReadRegStr $0 HKCU "Software\Google\Chrome\NativeMessagingHosts\com.interego.identity" ""
    ${If} $0 == "$APPDATA\Interego\identity-browser\com.interego.identity.json"
      DeleteRegValue HKCU "Software\Google\Chrome\NativeMessagingHosts\com.interego.identity" ""
    ${EndIf}
    ReadRegStr $0 HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.interego.identity" ""
    ${If} $0 == "$APPDATA\Interego\identity-browser\com.interego.identity.json"
      DeleteRegValue HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.interego.identity" ""
    ${EndIf}
  ${EndIf}
!macroend

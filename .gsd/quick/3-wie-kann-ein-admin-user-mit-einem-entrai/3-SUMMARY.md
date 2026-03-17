# Quick Task: Entra ID-joined Windows client — AD Scan support

**Date:** 2026-03-17
**Branch:** gsd/quick/3-wie-kann-ein-admin-user-mit-einem-entrai

## Analyse

**Frage:** Kann ein Admin-User auf einem Entra ID-gejointen Windows-Client den Microsoft AD-Scan durchführen?

**Antwort:**

| Szenario | Unterstützt | Methode |
|---|---|---|
| **Hybrid-joined** (Entra ID + On-Prem AD) | ✅ Ja | NTLM mit `DOMAIN\user` oder `user@domain.local` |
| **Hybrid-joined** | ✅ Ja | Kerberos mit On-Prem AD Username + Password + Realm |
| **Pure Entra ID-joined** (kein On-Prem AD) | ❌ Nein | Kein On-Prem AD → kein WinRM-Zugang zu DCs |

Der Scanner verbindet sich via **WinRM auf den Domain Controller** und führt PowerShell-Cmdlets aus (`Get-DnsServerZone`, `Get-DhcpServerv4Scope`, `Get-ADUser`). Das setzt voraus:
1. On-Prem Active Directory existiert
2. Der Benutzer hat On-Prem AD Credentials (kein Entra ID-only Account)
3. WinRM ist auf dem DC aktiv (Port 5985/5986)

Ein pure Entra ID-joined Client ohne On-Prem AD Credentials kann keinen AD-Scan durchführen.

## Was geändert wurde
- Kerberos-Methode: Label von "Windows / Kerberos (Current User)" → "Kerberos (username + password)" — das alte Label suggerierte SSO/Pass-Through, aber die Methode benötigt immer explizite Credentials
- **Kritischer Bug behoben**: Kerberos-Methode hatte keine `username`, `password`, `realm`, `kdc` Felder im UI — Backend erwartet diese jedoch. Felder hinzugefügt.
- NTLM-Methode: helpText erklärt dass Entra ID-only Accounts (`user@tenant.onmicrosoft.com`) nicht unterstützt werden
- PowerShell Remoting: umbenannt zu "PowerShell Remoting (WinRM / HTTPS)" für mehr Klarheit
- Alle Server-Felder: "Server Address(es)" → "Domain Controller"

## Files Modified
- `frontend/src/app/components/mock-data.ts`

## Verification
- `pnpm build` — clean (1741 modules, 157ms)

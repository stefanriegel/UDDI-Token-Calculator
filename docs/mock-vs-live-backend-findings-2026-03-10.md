# Mock vs Live Backend Side-by-Side Findings

Datum: 2026-03-10

## Scope

- Verglichen wurde der komplette Wizard-Flow in Demo/Mock-Modus gegen denselben Flow mit laufendem Go-Backend.
- Getestete Provider: AWS, Azure, Microsoft DHCP/DNS, NIOS.
- GCP war explizit out of scope.
- Mit geprueft: Ergebnissseite, Filter, Sortierung, Top-Consumer-Accordions, NIOS-X Migration Planner, Server Token Calculator, CSV- und XLS-Export.

## Test Setup

- Mock-Frontend: `http://localhost:5173`
- Live-Backend: `http://127.0.0.1:55413`
- Azure Tenant: `7cf6e39d-9589-4a0e-90dd-d5baf19c11cc`
- AWS SSO: `https://d-90677edb3e.awsapps.com/start/#`, Region `us-east-1`
- AD/DNS/DHCP:
  - `20.86.165.37`
  - `20.86.179.143`
  - `20.71.150.146`
- NIOS Backup: `ZF-database-03-2026.bak`

Live-Log Highlights:

- NIOS Upload: `100.0 MB`, `218 Grid Members found`
- Parser: `2324634 objects`
- Azure Validate: ca. `4.08s`
- AWS Validate: ca. `7.50s`
- AD Validate (NTLM): ca. `1.47s`
- Scan bis Results: ca. `95s`

## Side-by-Side Summary

| Bereich | Mock / Demo | Live Backend |
| --- | --- | --- |
| Credential-Validierung | Alle gewaehlten Provider validieren schnell mit Mock-Daten | Azure SSO, AWS SSO und AD NTLM validieren; Microsoft Default-Auth scheitert |
| NIOS Upload | `8 Grid Members found` | `218 Grid Members found` |
| Source Defaults | AWS `4/185`, Azure `4/595`, Microsoft `2/6`, NIOS `6/8` bereits vorausgewaehlt | AWS `0/1`, Azure `0/1`, Microsoft `0/3`, NIOS `218/218` |
| Scan-Ergebnis | `110 line items`, `6.181` Tokens | `43 line items`, `56.315` Tokens |
| Results Hero | Mehrere Mock-Sources, mehrere NIOS-Member sichtbar | NIOS dominiert, praktisch alles auf einem NIOS-Source aggregiert |
| Migration Planner | `0 of 6` bzw. mehrere Member auswaehlbar | effektiv `1 of 1` Member |
| Server Token Calculator | 6 Mock-Member, differenzierte Rollen | 1 aggregierter Live-Member / 1 XaaS-Instanz |
| Export | CSV/XLS funktionieren | CSV/XLS funktionieren |

## Flow Notes

### 1. Provider Selection

- Kein relevanter Unterschied. Beide Varianten zeigen dieselben Provider-Karten.

### 2. Credentials

Mock:

- AWS, Azure, Microsoft und NIOS validieren ohne echte Backend-Pruefung.
- NIOS verarbeitet dieselbe `.bak` nur gegen Mock-Parserlogik und meldet `8 Grid Members found`.

Live:

- Azure Browser SSO erfolgreich.
- AWS IAM Identity Center SSO erfolgreich.
- Microsoft Default-Auth `Windows / Kerberos (Current User)` scheitert sofort mit `server address, username, and password are required`.
- Microsoft NTLM mit `CORP\labadmin` validiert erfolgreich und liefert 3 Server:
  - `dc-blox42 (20.86.165.37)`
  - `dc-blox42-02 (20.86.179.143)`
  - `dc-blox42-03 (20.71.150.146)`
- NIOS Upload validiert erfolgreich und liefert `218 Grid Members found`.

### 3. Source Selection

Mock:

- Mehrere AWS/Azure/MS/NIOS Sources sind bereits vorausgewaehlt.

Live:

- AWS, Azure und Microsoft kommen unselektiert zurueck.
- Nur NIOS ist direkt selektiert.
- Ohne manuelle Nachselektion haette der User einen stark anderen Scan als im Demo-Flow.

### 4. Scan

Mock:

- Schneller Simulationslauf.
- Ergebnis: `110 line items across 4 providers`.

Live:

- Realer Scan mit echten Daten.
- Ergebnis: `43 line items across 4 providers`.

### 5. Results Page

Mock:

- Top-Consumer, Category Cards, Detailed Findings, Planner, Server Calculator und Exporte funktional.
- NIOS wird ueber mehrere Member verteilt dargestellt.

Live:

- Category Filter `Active IPs` funktioniert.
- Tabellen-Sortierung funktioniert.
- Top-Consumer-Accordion funktioniert.
- Planner-Target-Wechsel `NIOS-X` <-> `XaaS` funktioniert.
- CSV/XLS Download funktioniert.
- NIOS wird nahezu komplett auf `lf1n77001.apa.zf-world.com` aggregiert.

## Runtime-Tested Findings

### [P1] Microsoft-Default-Flow ist live kaputt

Symptom:

- Im Demo-Flow wirkt `Windows / Kerberos (Current User)` wie der Happy Path.
- Im Live-Flow ist derselbe Default-Path nicht nutzbar und verlangt faktisch NTLM-Credentials.

Repro:

1. Microsoft DHCP/DNS auswaehlen.
2. Auth-Methode auf Default `Windows / Kerberos (Current User)` lassen.
3. Nur Server-Adresse(n) eintragen.
4. `Validate & Connect` klicken.

Beobachtung:

- Demo: Validierung erfolgreich.
- Live: Fehler `server address, username, and password are required`.

Impact:

- Der Default-Flow im UI ist im Realbetrieb irrefuehrend.
- Ein Nutzer landet ohne erkennbaren Grund in einem Fehlerzustand, obwohl er dem vorgeschlagenen UI-Flow folgt.

Evidence:

- Frontend Default: `frontend/src/app/components/wizard.tsx:202-208`
- UI-Text fuer Kerberos/Current User: `frontend/src/app/components/mock-data.ts:219-225`
- Backend unterstuetzt effektiv nur Username/Password: `server/validate.go:657-680`

Empfohlener Fix:

- Entweder echten Kerberos/Current-User-Flow implementieren.
- Oder die Kerberos-Option live deaktivieren/ausblenden und NTLM zum Default machen.

Acceptance Criteria:

- Der UI-Default funktioniert im Live-Betrieb ohne Workaround.
- Oder der UI-Default wird auf eine wirklich implementierte Methode umgestellt.
- Fehlertext und Hilfetext spiegeln die tatsaechlich unterstuetzten Auth-Flows korrekt wider.

### [P1] Source-Default-Selektion ist zwischen Demo und Live nicht paritaetisch

Symptom:

- Demo startet mit bereits selektierten AWS/Azure/MS-Sources.
- Live setzt fuer AWS/Azure/MS alle Rueckgaben auf `selected: false`.

Repro:

1. Dieselben vier Provider in Mock und Live validieren.
2. Zur Source-Seite gehen.
3. Vorauswahl vergleichen.

Beobachtung:

- Mock:
  - AWS `4 of 185 will be scanned`
  - Azure `4 of 595 will be scanned`
  - Microsoft `2 of 6 will be scanned`
  - NIOS `6 of 8 will be scanned`
- Live:
  - AWS `0 of 1 will be scanned`
  - Azure `0 of 1 will be scanned`
  - Microsoft `0 of 3 will be scanned`
  - NIOS `218 of 218 will be scanned`

Impact:

- Derselbe User-Flow fuehrt zu einem anderen Scanumfang.
- Weil NIOS vorausgewaehlt ist, kann der User trotz leerer AWS/Azure/MS-Selektion weitergehen und ein unvollstaendiges Resultat erzeugen.

Evidence:

- Mock uebernimmt vorhandene `selected`-Flags: `frontend/src/app/components/wizard.tsx:341-349`
- Live setzt jede Rueckgabe explizit auf `selected: false`: `frontend/src/app/components/wizard.tsx:380-385`
- Mock-Defaults liegen in `frontend/src/app/components/mock-data.ts:297-368`

Empfohlener Fix:

- Einheitliches Selektionsverhalten fuer Demo und Live definieren.
- Entweder live ebenfalls sinnvolle Defaults setzen oder im Demo dieselbe Null-Selektion simulieren.
- Optional: Blocking/Warning, wenn ein gewaehlter Provider `0` effektive Sources hat.

Acceptance Criteria:

- Mock und Live verhalten sich bei identischer User-Interaktion gleich.
- Ein Provider mit `0` effektiven Sources kann nicht stillschweigend in den Scan rutschen.

### [P1] Live-NIOS-Resultate kollabieren eine 218-Member-Grid auf effektiv 1 sichtbaren Member

Symptom:

- Der Live-Upload erkennt `218 Grid Members`.
- Die Results-Seite, der Migration Planner und der Server Token Calculator zeigen effektiv nur einen relevanten NIOS-Member.

Repro:

1. Live NIOS-Backup hochladen.
2. Bestaetigen, dass `218 Grid Members found` angezeigt wird.
3. Alle NIOS-Member im Source-Step eingeschlossen lassen.
4. Scan bis zur Results-Seite durchlaufen.

Beobachtung:

- Hero, Findings und Planner fokussieren fast ausschliesslich `lf1n77001.apa.zf-world.com`.
- Planner: `1 of 1 members selected`
- Server Token Calculator: 1 Member bzw. 1 XaaS-Instanz

Impact:

- Die Ergebnisseite bildet die reale Grid-Struktur nicht ab.
- Der Migration Planner ist fuer echte Mehr-Member-Grids praktisch nicht nutzbar.
- Server Sizing wird durch starke Aggregation verzerrt.

Evidence:

- Live Parser/Upload erkannte `218` Member.
- Scanner ordnet grid-weite DDI-/IP-Werte dem GM zu: `internal/scanner/nios/counter.go:58-186`
- Result Rows verwenden fuer fast alle gridweiten NIOS-Werte `Source: gmHostname`: `internal/scanner/nios/scanner.go:174-227`
- Filter auf `selectedMembers` laesst GM immer durch: `internal/scanner/nios/scanner.go:237-252`
- Metrics geben dem GM zusaetzlich `gridDDI`: `internal/scanner/nios/scanner.go:262-292`

Empfohlener Fix:

- Klar entscheiden, ob per-member Attribution fachlich moeglich ist.
- Wenn ja: DDI/IP/Assets granularer auf Member verteilen.
- Wenn nein: Results/Planner explizit als grid-level aggregation labeln und Planner/Server Calculator nicht member-fein simulieren.

Acceptance Criteria:

- Ein Live-Backup mit vielen Membern fuehrt entweder zu mehreren sinnvoll nutzbaren Membern im Planner.
- Oder die UI kommuniziert explizit, dass nur grid-level aggregation verfuegbar ist und blendet member-genaue Controls aus.

### [P2] Live-Labels auf der Results-Seite sind roh und weichen stark vom Demo-Vokabular ab

Symptom:

- Mock nutzt lesbare Labels wie `Azure DNS Zones`, `VM IPs`, `Network Interfaces`, `DNS Resource Records`.
- Live zeigt rohe Scanner-Keys wie `dns_zone`, `dns_record`, `virtual_machine`, `ec2_ip`, `user_account`.

Repro:

1. Mock und Live bis zur Results-Seite durchlaufen.
2. Detailed Findings und CSV vergleichen.

Beobachtung:

- Mock-CSV: fachlich lesbare, user-facing Labels.
- Live-CSV: technische Keys.

Impact:

- Side-by-Side-Vergleich ist fuer Endnutzer unnoetig schwer.
- Export-Artefakte wirken wie interne Scanner-Daten statt wie ein Produkt-Report.

Evidence:

- Mock-Labelling: `frontend/src/app/components/mock-data.ts:414-520`
- Live passt nur Kategorien an, nicht Items: `frontend/src/app/components/wizard.tsx:526-535`
- Azure Scanner emittiert rohe Keys: `internal/scanner/azure/scanner.go:177-277`
- AWS Scanner emittiert rohe Keys: `internal/scanner/aws/regions.go:90-115`
- AD Scanner emittiert rohe Keys: `internal/scanner/ad/scanner.go:197-240`
- Results API reicht Items 1:1 durch: `server/scan.go:388-406`

Empfohlener Fix:

- Gemeinsame Label-Mapping-Schicht fuer Mock und Live einfuehren.
- Idealerweise backend-seitig kanonische, user-facing Labels liefern.

Acceptance Criteria:

- Dieselbe Ressourcentype erscheint in Mock und Live unter derselben Bezeichnung.
- CSV/XLS und UI verwenden dieselbe Taxonomie.

### [P2] Live rendert und exportiert 0-Count-/0-Token-Zeilen

Symptom:

- Live-Results enthalten Zeilen wie `load_balancer = 0`, `application_gateway = 0`.

Repro:

1. Live-Scan ausfuehren.
2. Detailed Findings und CSV ansehen.

Beobachtung:

- Beispiele aus dem Live-CSV:
  - Azure `load_balancer,0,0`
  - Azure `application_gateway,0,0`
  - AWS `load_balancer,0,0`

Impact:

- Die Ergebnistabelle wird verrauscht.
- Nutzer koennen Zero-Rows als Defekt oder halbfertigen Scan missverstehen.

Evidence:

- Azure appendet Rows auch bei `0`: `internal/scanner/azure/scanner.go:245-277`
- AWS gibt auf Fehler oder 0-Count Zero-Rows zurueck: `internal/scanner/aws/regions.go:118-168`
- Result-Aggregation filtert Zero-Rows nicht heraus: `server/scan.go:512-562`

Empfohlener Fix:

- Zero-Rows vor UI/Export filtern.
- Falls Zero-Rows fachlich gewollt sind, dann nur optional in einem erweiterten Debug-View zeigen.

Acceptance Criteria:

- Standard-UI und Standard-CSV enthalten keine Count-0/Token-0-Zeilen mehr.

### [P1] CSV-Export der Results ist nicht robust darstellbar und nicht parser-sicher

Symptom:

- Der CSV-Export ist kein stabiles tabellarisches Format.
- Felder mit Kommas werden nicht gequotet.
- Zusaetzliche Summary-Bloecke haben andere Spaltenzahlen als die Haupttabelle.

Repro:

1. Mock- und Live-Results bis zum CSV-Download durchlaufen.
2. CSV in Excel, LibreOffice oder per `csv.reader` einlesen.

Beobachtung:

- Live-CSV bricht bereits in den Microsoft-Zeilen, weil `Source = "dc-blox42-02, dc-blox42, dc-blox42-03"` ungequotet exportiert wird.
- Mock- und Live-CSV haengen unterhalb der Tabelle freie Summary-Sektionen an, zum Beispiel `Server Token Calculator` oder `NIOS-X Migration Planner`.
- Die Datei ist damit weder sauber maschinenlesbar noch als konsistente Tabelle importierbar.

Technischer Nachweis aus diesem Lauf:

- `/tmp/mock-ddi-token-assessment.csv`: `11` Zeilen mit abweichender Spaltenzahl
- `/tmp/live-ddi-token-assessment.csv`: `24` Zeilen mit abweichender Spaltenzahl

Impact:

- Der wichtigste Export der Ergebnissseite ist fuer Weiterverarbeitung unzuverlaessig.
- Excel-Import, BI-Import und agentische Nachbearbeitung koennen fehlschlagen oder falsche Spaltenzuordnung erzeugen.

Evidence:

- CSV wird per String-Interpolation ohne Escaping gebaut: `frontend/src/app/components/wizard.tsx:644-702`
- Problematische Felder mit Kommas wurden live erzeugt, z. B. Microsoft-Source.

Empfohlener Fix:

- CSV mit echtem CSV-Escaping erzeugen.
- Entweder nur eine einzige tabellarische Struktur exportieren.
- Oder getrennte Exporte anbieten, z. B. `findings.csv`, `migration-planner.csv`, `server-calculator.csv`.

Acceptance Criteria:

- Jede CSV-Zeile der Hauptdatei hat dieselbe Spaltenzahl.
- Felder mit Kommas, Quotes oder Zeilenumbruechen werden korrekt escaped.
- Summary-Daten brechen die Tabellenstruktur nicht mehr.

### [P2] `Download XLSX` ist falsch beschriftet und liefert kein echtes XLSX

Symptom:

- Die UI verspricht `Download XLSX`.
- Tatsachlich wird eine `.xls`-Datei mit HTML-Inhalt erzeugt.

Repro:

1. Auf der Results-Seite `Download XLSX` klicken.
2. Dateinamen und Export-Code vergleichen.

Beobachtung:

- Download-Datei: `ddi-token-assessment.xls`
- MIME-Type: `application/vnd.ms-excel`
- Inhalt: HTML-Tabelle, kein echtes OpenXML-Workbook (`.xlsx`)

Impact:

- Nutzer bekommen ein anderes Dateiformat als angekuendigt.
- Downstream-Tools oder Automationen, die echtes `.xlsx` erwarten, sind fehleranfaellig.

Evidence:

- Button-Label: `frontend/src/app/components/wizard.tsx:2810-2816`
- Tatsaechlicher Export: `frontend/src/app/components/wizard.tsx:708-775`
- Dateiname `.xls`: `frontend/src/app/components/wizard.tsx:774`

Empfohlener Fix:

- Entweder den Button korrekt in `Download XLS` umbenennen.
- Oder ein echtes `.xlsx` erzeugen.

Acceptance Criteria:

- UI-Label und ausgeliefertes Dateiformat stimmen ueberein.

### [P2] Hero-Prozentwerte der Results runden kleine, aber reale Beitraege zu `0%`

Symptom:

- In der Hero-Summary erscheinen kleinere Quellen als `0%`, obwohl sie nicht null sind.

Repro:

1. Live-Results mit stark dominanter NIOS-Quelle oeffnen.
2. Hero-Card `By Accounts / Subscriptions / Servers / Grid Members` ansehen.

Beobachtung:

- Beispiel live:
  - MS DHCP/DNS `51` Tokens -> `(0%)`
  - AWS `24` Tokens -> `(0%)`
  - Azure `16` Tokens -> `(0%)`
- Diese Werte sind klein gegenueber `56.315`, aber nicht null.

Impact:

- Die visuelle Aussage ist irrefuehrend.
- Kleine, aber vorhandene Beitragsquellen wirken wie nicht vorhanden.

Evidence:

- Prozent wird gerundet mit `Math.round(pct)`: `frontend/src/app/components/wizard.tsx:1729-1744`

Empfohlener Fix:

- Prozentwerte mit einer Nachkommastelle oder mit Mindestanzeige `<1%` darstellen.

Acceptance Criteria:

- Nicht-null Quellen erscheinen nicht mehr als `0%`.

### [P3] Regionale Detailinformation geht in der Results-Darstellung verloren

Symptom:

- Die Results API aggregiert gleiche `(provider, source, item)`-Zeilen ueber Regionen hinweg.
- Dabei wird die Region aktiv entfernt.

Impact:

- Der Nutzer sieht Summen, aber nicht mehr, aus welchen Regionen diese stammen.
- Das betrifft besonders AWS und Azure, wenn dieselbe Ressource in mehreren Regionen vorkommt.

Evidence:

- Aggregation ueber `(provider, source, item)`: `server/scan.go:523-543`
- Region wird explizit geleert: `server/scan.go:531`

Empfohlener Fix:

- Entweder Region als sichtbare Drilldown-Ebene behalten.
- Oder in der UI klar markieren, dass es sich um regionsaggregierte Summen handelt.

Acceptance Criteria:

- Regionale Daten gehen nicht stillschweigend verloren.

### [P3] Realer NIOS-Upload ist massiv langsamer als der Demo-Flow und hat keine echte Parse-Progression

Symptom:

- Demo verarbeitet dieselbe Datei nahezu sofort.
- Live braucht fuer die Datei ca. 33 Sekunden bis zur Rueckgabe.

Impact:

- Der Demo-Flow setzt falsche Erwartungen an den Live-Flow.
- Bei grossen Backups fehlt eine klare, vertrauensbildende Parse-Progression.

Evidence:

- Live-Log: Upload/Parse ca. 33s, `2324634 objects`
- Demo validiert NIOS in ca. 1.2s per Timeout in `frontend/src/app/components/wizard.tsx:341-349`

Empfohlener Fix:

- Progress/Phase-Feedback fuer Upload vs Parse vs Member-Discovery anzeigen.
- Optional grobe ETA oder Dateigroessen-Hinweis.

Acceptance Criteria:

- Bei grossen NIOS-Backups sieht der User waehrend des Wartens einen eindeutigen Fortschrittszustand.

## Code-Inspection-Only Parity Gaps

Diese Punkte wurden in diesem Lauf nicht manuell live ausgefuehrt, sind aber im Code klar sichtbar und sollten in denselben Backlog:

### [P2] UI bietet Auth-Methoden an, die live mit `Coming soon` enden

- AWS `profile` und `assume-role` existieren im UI: `frontend/src/app/components/mock-data.ts:89-115`
- Backend liefert dafuer `Coming soon`: `server/validate.go:399-406`
- Azure `device-code` existiert im UI: `frontend/src/app/components/mock-data.ts:135-140`
- Backend liefert dafuer `Coming soon`: `server/validate.go:510-516`

Empfohlener Fix:

- Nicht implementierte Methoden im Live-Mode ausblenden oder als disabled/coming-soon markieren.

## Results Page Verification Checklist

Folgende Funktionen wurden live und/oder im Mock explizit geprueft:

- Results-Seite laedt nach abgeschlossenem Scan.
- Hero Summary zeigt Top-Sources.
- Top-Consumer-Accordion expandiert.
- Category Filter funktioniert.
- Tabellen-Sortierung funktioniert.
- NIOS-X Migration Planner reagiert auf Member-/Target-Aenderungen.
- Server Token Calculator aktualisiert sich.
- CSV Download funktioniert.
- XLS Download funktioniert.

## Artifacts

- Mock Screenshot: `/tmp/mock-results.png`
- Live Screenshot: `/tmp/live-results.png`
- Mock CSV: `/tmp/mock-ddi-token-assessment.csv`
- Live CSV: `/tmp/live-ddi-token-assessment.csv`

## Suggested Work Order For An Agentic Coder

1. Microsoft-Auth-Paritaet fixen oder UI-Default korrigieren.
2. Source-Selection-Paritaet zwischen Demo und Live angleichen.
3. NIOS-Member-Attribution/Planner-Logik fachlich geradeziehen.
4. Gemeinsame Item-Label-Taxonomie fuer Mock und Live einfuehren.
5. Zero-Rows aus UI/Export entfernen.
6. Live-UX fuer grossen NIOS-Upload verbessern.
7. Nicht implementierte Auth-Methoden im Live-Mode korrekt kennzeichnen.

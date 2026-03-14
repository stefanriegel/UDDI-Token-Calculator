# T02: 10-nios-backend-scanner 02

**Slice:** S02 — **Milestone:** M002

## Description

Implement the three pure-logic packages for the NIOS scanner: family mapping, counting accumulator, and service role extraction. No file I/O or XML streaming in this plan — that is Wave 2.

Purpose: Isolates testable business logic from I/O so unit tests run in microseconds without touching the filesystem.
Output: families.go, counter.go, roles.go — all pure functions, no imports of archive/tar or compress/gzip.

## Must-Haves

- [ ] "XMLTypeToFamily maps every __type string from the ZF reference backup to a NiosFamily constant"
- [ ] "countObjects() produces per-member DDI/IP/Asset counts attributed to GM for grid-level objects"
- [ ] "Active IPs are deduplicated across leases, fixed addresses, host addresses, and network reservations"
- [ ] "extractServiceRole() returns GM, GMC, DNS, DHCP, DNS/DHCP, IPAM, or Reporting from member PROPERTY values"

## Files

- `internal/scanner/nios/families.go`
- `internal/scanner/nios/counter.go`
- `internal/scanner/nios/roles.go`

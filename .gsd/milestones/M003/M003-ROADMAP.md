# M003: Auth Method Completion

**Vision:** Implement or gracefully handle all 9 unimplemented auth methods across AWS, Azure, GCP, and AD providers — eliminating silent mismatches, confusing fall-through errors, and "Coming soon" stubs.

## Success Criteria


## Slices

- [x] **S01: Quick Win Auth Methods** `risk:medium` `depends:[]`
  > After this: Create failing test stubs (Wave 0 / Nyquist compliance) for the 5 new auth method behaviors that plans 15-01 and 15-02 will implement.
- [x] **S02: Certificate, Device Code, and Kerberos Auth** `risk:medium` `depends:[S01]`
  > After this: unit tests prove Certificate, Device Code, and Kerberos Auth works
- [ ] **S03: GCP Advanced Auth** `risk:medium` `depends:[S02]`
  > After this: unit tests prove GCP Advanced Auth works

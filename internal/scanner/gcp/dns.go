package gcp

import (
	"context"
	"fmt"

	dnsv1 "google.golang.org/api/dns/v1"
	"google.golang.org/api/option"
	"golang.org/x/oauth2"
)

// countDNS returns the total number of managed DNS zones and DNS resource record sets
// broken down by record type across all zones in the project. Both public and private
// zones are counted (no visibility filter).
//
// On per-zone record enumeration error, the error is logged and scanning continues.
// The last zone error is returned as err if any zone failed; zoneCount and typeCounts
// reflect the successfully scanned data.
func countDNS(ctx context.Context, ts oauth2.TokenSource, projectID string) (zoneCount int, typeCounts map[string]int, err error) {
	typeCounts = make(map[string]int)

	svc, err := dnsv1.NewService(ctx, option.WithTokenSource(ts))
	if err != nil {
		return 0, nil, fmt.Errorf("dns: failed to create DNS service: %w", err)
	}

	// Collect zone names while counting zones.
	var zoneNames []string

	// List all managed zones — no visibility filter to count both public AND private zones (GCP-03).
	if listErr := svc.ManagedZones.List(projectID).Pages(ctx, func(page *dnsv1.ManagedZonesListResponse) error {
		for _, zone := range page.ManagedZones {
			zoneNames = append(zoneNames, zone.Name)
		}
		zoneCount += len(page.ManagedZones)
		return nil
	}); listErr != nil {
		return 0, nil, wrapGCPError(listErr)
	}

	// For each zone, list all resource record sets.
	var lastZoneErr error
	for _, zoneName := range zoneNames {
		if rrErr := svc.ResourceRecordSets.List(projectID, zoneName).Pages(ctx, func(page *dnsv1.ResourceRecordSetsListResponse) error {
			for _, rrset := range page.Rrsets {
				typeCounts[rrset.Type]++
			}
			return nil
		}); rrErr != nil {
			// Log error and continue — do not abort all DNS scanning on a single zone failure.
			lastZoneErr = fmt.Errorf("dns records for zone %s: %w", zoneName, rrErr)
		}
	}

	return zoneCount, typeCounts, lastZoneErr
}

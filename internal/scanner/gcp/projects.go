package gcp

import (
	"context"
	"fmt"

	resourcemanager "cloud.google.com/go/resourcemanager/apiv3"
	"cloud.google.com/go/resourcemanager/apiv3/resourcemanagerpb"
	"golang.org/x/oauth2"
	"google.golang.org/api/iterator"
	"google.golang.org/api/option"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/cloudutil"
)

// ProjectInfo describes a single GCP project discovered via Resource Manager.
type ProjectInfo struct {
	ID    string // project ID (e.g. "my-project-123")
	Name  string // display name
	State string // lifecycle state (e.g. "ACTIVE")
}

// resourceManagerAPI abstracts the Resource Manager SDK operations needed for
// project discovery. Defined as an interface for testability — the real
// implementation wraps ProjectsClient and FoldersClient.
type resourceManagerAPI interface {
	// SearchProjects returns all projects whose direct parent matches the query.
	// query is the SearchProjects query string (e.g. "parent:organizations/123").
	SearchProjects(ctx context.Context, query string) ([]*resourcemanagerpb.Project, error)

	// ListFolders returns all folders directly under the given parent.
	// parent is a resource name like "organizations/123" or "folders/456".
	ListFolders(ctx context.Context, parent string) ([]*resourcemanagerpb.Folder, error)
}

// realResourceManagerClient wraps the actual GCP SDK clients.
type realResourceManagerClient struct {
	projects *resourcemanager.ProjectsClient
	folders  *resourcemanager.FoldersClient
}

func (c *realResourceManagerClient) SearchProjects(ctx context.Context, query string) ([]*resourcemanagerpb.Project, error) {
	var projects []*resourcemanagerpb.Project
	it := c.projects.SearchProjects(ctx, &resourcemanagerpb.SearchProjectsRequest{
		Query: query,
	})
	for {
		proj, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return nil, err
		}
		projects = append(projects, proj)
	}
	return projects, nil
}

func (c *realResourceManagerClient) ListFolders(ctx context.Context, parent string) ([]*resourcemanagerpb.Folder, error) {
	var folders []*resourcemanagerpb.Folder
	it := c.folders.ListFolders(ctx, &resourcemanagerpb.ListFoldersRequest{
		Parent: parent,
	})
	for {
		folder, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return nil, err
		}
		folders = append(folders, folder)
	}
	return folders, nil
}

// DiscoverProjects discovers all ACTIVE projects under a GCP organization.
// It creates Resource Manager clients using the provided token source and
// delegates to discoverProjectsWithClient.
func DiscoverProjects(ctx context.Context, ts oauth2.TokenSource, orgID string) ([]ProjectInfo, error) {
	opts := []option.ClientOption{option.WithTokenSource(ts)}

	projClient, err := resourcemanager.NewProjectsClient(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("gcp: create projects client for organizations/%s: %w", orgID, err)
	}
	defer projClient.Close()

	folderClient, err := resourcemanager.NewFoldersClient(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("gcp: create folders client for organizations/%s: %w", orgID, err)
	}
	defer folderClient.Close()

	client := &realResourceManagerClient{
		projects: projClient,
		folders:  folderClient,
	}
	return discoverProjectsWithClient(ctx, client, orgID)
}

// discoverProjectsWithClient is the testable core of project discovery.
// It uses BFS folder traversal to find all folders in the org, then searches
// for projects under each parent (org + folders), and returns only ACTIVE projects.
func discoverProjectsWithClient(ctx context.Context, client resourceManagerAPI, orgID string) ([]ProjectInfo, error) {
	orgParent := fmt.Sprintf("organizations/%s", orgID)
	seen := make(map[string]bool)
	var result []ProjectInfo

	// Collect all parent resource names to search for projects: org root + all folders.
	parents := []string{orgParent}

	// BFS to discover all folders in the org hierarchy.
	queue := []string{orgParent}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]

		folders, err := cloudutil.CallWithBackoff(ctx, func() ([]*resourcemanagerpb.Folder, error) {
			return client.ListFolders(ctx, current)
		}, cloudutil.BackoffOptions{
			MaxRetries:  5,
			IsRetryable: isGCPRetryable,
		})
		if err != nil {
			return nil, fmt.Errorf("gcp: list folders under %s: %w", current, err)
		}

		for _, f := range folders {
			if f.GetState() == resourcemanagerpb.Folder_ACTIVE {
				parents = append(parents, f.GetName())
				queue = append(queue, f.GetName())
			}
		}
	}

	// Search for projects under each parent (org root + discovered folders).
	for _, parent := range parents {
		query := fmt.Sprintf("parent:%s", parent)
		projects, err := cloudutil.CallWithBackoff(ctx, func() ([]*resourcemanagerpb.Project, error) {
			return client.SearchProjects(ctx, query)
		}, cloudutil.BackoffOptions{
			MaxRetries:  5,
			IsRetryable: isGCPRetryable,
		})
		if err != nil {
			return nil, fmt.Errorf("gcp: search projects under %s: %w", parent, err)
		}

		for _, p := range projects {
			if p.GetState() != resourcemanagerpb.Project_ACTIVE {
				continue
			}
			if seen[p.GetProjectId()] {
				continue
			}
			seen[p.GetProjectId()] = true
			result = append(result, ProjectInfo{
				ID:    p.GetProjectId(),
				Name:  p.GetDisplayName(),
				State: p.GetState().String(),
			})
		}
	}

	return result, nil
}

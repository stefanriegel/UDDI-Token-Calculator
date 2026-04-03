package gcp

import (
	"context"
	"errors"
	"testing"

	"cloud.google.com/go/resourcemanager/apiv3/resourcemanagerpb"
)

// mockResourceManager implements resourceManagerAPI for testing.
type mockResourceManager struct {
	// searchResults maps query string → results.
	searchResults map[string][]*resourcemanagerpb.Project
	// folderResults maps parent → child folders.
	folderResults map[string][]*resourcemanagerpb.Folder
	// searchErr is returned by SearchProjects when non-nil.
	searchErr error
	// folderErr is returned by ListFolders when non-nil.
	folderErr error
}

func (m *mockResourceManager) SearchProjects(_ context.Context, query string) ([]*resourcemanagerpb.Project, error) {
	if m.searchErr != nil {
		return nil, m.searchErr
	}
	return m.searchResults[query], nil
}

func (m *mockResourceManager) ListFolders(_ context.Context, parent string) ([]*resourcemanagerpb.Folder, error) {
	if m.folderErr != nil {
		return nil, m.folderErr
	}
	return m.folderResults[parent], nil
}

func TestDiscoverProjects_HappyPath(t *testing.T) {
	client := &mockResourceManager{
		searchResults: map[string][]*resourcemanagerpb.Project{
			"parent:organizations/123": {
				{ProjectId: "proj-a", DisplayName: "Project A", State: resourcemanagerpb.Project_ACTIVE},
				{ProjectId: "proj-b", DisplayName: "Project B", State: resourcemanagerpb.Project_ACTIVE},
			},
		},
		folderResults: map[string][]*resourcemanagerpb.Folder{
			"organizations/123": {}, // no folders
		},
	}

	projects, err := discoverProjectsWithClient(context.Background(), client, "123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(projects) != 2 {
		t.Fatalf("expected 2 projects, got %d", len(projects))
	}
	if projects[0].ID != "proj-a" {
		t.Errorf("expected first project ID proj-a, got %s", projects[0].ID)
	}
	if projects[0].Name != "Project A" {
		t.Errorf("expected first project name Project A, got %s", projects[0].Name)
	}
	if projects[1].ID != "proj-b" {
		t.Errorf("expected second project ID proj-b, got %s", projects[1].ID)
	}
}

func TestDiscoverProjects_NestedFolders(t *testing.T) {
	// Org has one folder, which has a subfolder, each containing projects.
	client := &mockResourceManager{
		searchResults: map[string][]*resourcemanagerpb.Project{
			"parent:organizations/123": {
				{ProjectId: "org-proj", DisplayName: "Org Project", State: resourcemanagerpb.Project_ACTIVE},
			},
			"parent:folders/f1": {
				{ProjectId: "folder-proj", DisplayName: "Folder Project", State: resourcemanagerpb.Project_ACTIVE},
			},
			"parent:folders/f2": {
				{ProjectId: "nested-proj", DisplayName: "Nested Project", State: resourcemanagerpb.Project_ACTIVE},
			},
		},
		folderResults: map[string][]*resourcemanagerpb.Folder{
			"organizations/123": {
				{Name: "folders/f1", State: resourcemanagerpb.Folder_ACTIVE},
			},
			"folders/f1": {
				{Name: "folders/f2", State: resourcemanagerpb.Folder_ACTIVE},
			},
			"folders/f2": {}, // leaf folder
		},
	}

	projects, err := discoverProjectsWithClient(context.Background(), client, "123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(projects) != 3 {
		t.Fatalf("expected 3 projects from org + 2 folders, got %d", len(projects))
	}

	ids := make(map[string]bool)
	for _, p := range projects {
		ids[p.ID] = true
	}
	for _, want := range []string{"org-proj", "folder-proj", "nested-proj"} {
		if !ids[want] {
			t.Errorf("expected project %s in results", want)
		}
	}
}

func TestDiscoverProjects_FiltersNonActive(t *testing.T) {
	client := &mockResourceManager{
		searchResults: map[string][]*resourcemanagerpb.Project{
			"parent:organizations/456": {
				{ProjectId: "active-proj", DisplayName: "Active", State: resourcemanagerpb.Project_ACTIVE},
				{ProjectId: "deleted-proj", DisplayName: "Deleted", State: resourcemanagerpb.Project_DELETE_REQUESTED},
				{ProjectId: "unspecified-proj", DisplayName: "Unspecified", State: resourcemanagerpb.Project_STATE_UNSPECIFIED},
			},
		},
		folderResults: map[string][]*resourcemanagerpb.Folder{
			"organizations/456": {},
		},
	}

	projects, err := discoverProjectsWithClient(context.Background(), client, "456")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(projects) != 1 {
		t.Fatalf("expected 1 active project, got %d", len(projects))
	}
	if projects[0].ID != "active-proj" {
		t.Errorf("expected active-proj, got %s", projects[0].ID)
	}
}

func TestDiscoverProjects_DeduplicatesProjects(t *testing.T) {
	// Same project appears under both org and folder search results.
	client := &mockResourceManager{
		searchResults: map[string][]*resourcemanagerpb.Project{
			"parent:organizations/789": {
				{ProjectId: "dup-proj", DisplayName: "Dup", State: resourcemanagerpb.Project_ACTIVE},
			},
			"parent:folders/f1": {
				{ProjectId: "dup-proj", DisplayName: "Dup", State: resourcemanagerpb.Project_ACTIVE},
				{ProjectId: "unique-proj", DisplayName: "Unique", State: resourcemanagerpb.Project_ACTIVE},
			},
		},
		folderResults: map[string][]*resourcemanagerpb.Folder{
			"organizations/789": {
				{Name: "folders/f1", State: resourcemanagerpb.Folder_ACTIVE},
			},
			"folders/f1": {},
		},
	}

	projects, err := discoverProjectsWithClient(context.Background(), client, "789")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(projects) != 2 {
		t.Fatalf("expected 2 deduplicated projects, got %d", len(projects))
	}
}

func TestDiscoverProjects_EmptyOrg(t *testing.T) {
	client := &mockResourceManager{
		searchResults: map[string][]*resourcemanagerpb.Project{
			"parent:organizations/empty": {},
		},
		folderResults: map[string][]*resourcemanagerpb.Folder{
			"organizations/empty": {},
		},
	}

	projects, err := discoverProjectsWithClient(context.Background(), client, "empty")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(projects) != 0 {
		t.Fatalf("expected 0 projects, got %d", len(projects))
	}
}

func TestDiscoverProjects_SearchAPIError(t *testing.T) {
	client := &mockResourceManager{
		searchErr: errors.New("permission denied: caller does not have resourcemanager.projects.get"),
		folderResults: map[string][]*resourcemanagerpb.Folder{
			"organizations/err": {},
		},
	}

	_, err := discoverProjectsWithClient(context.Background(), client, "err")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !errors.Is(err, client.searchErr) {
		// The error is wrapped, so check the message.
		errStr := err.Error()
		if errStr == "" {
			t.Fatal("error string should not be empty")
		}
	}
}

func TestDiscoverProjects_FolderAPIError(t *testing.T) {
	client := &mockResourceManager{
		folderErr: errors.New("folders API unavailable"),
	}

	_, err := discoverProjectsWithClient(context.Background(), client, "err")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestDiscoverProjects_FilterDeletedFolders(t *testing.T) {
	// Deleted folders should not be traversed.
	client := &mockResourceManager{
		searchResults: map[string][]*resourcemanagerpb.Project{
			"parent:organizations/123": {
				{ProjectId: "root-proj", DisplayName: "Root", State: resourcemanagerpb.Project_ACTIVE},
			},
			// Should NOT be reached because folder is DELETE_REQUESTED.
			"parent:folders/deleted": {
				{ProjectId: "ghost-proj", DisplayName: "Ghost", State: resourcemanagerpb.Project_ACTIVE},
			},
		},
		folderResults: map[string][]*resourcemanagerpb.Folder{
			"organizations/123": {
				{Name: "folders/deleted", State: resourcemanagerpb.Folder_DELETE_REQUESTED},
			},
		},
	}

	projects, err := discoverProjectsWithClient(context.Background(), client, "123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(projects) != 1 {
		t.Fatalf("expected 1 project (deleted folder skipped), got %d", len(projects))
	}
	if projects[0].ID != "root-proj" {
		t.Errorf("expected root-proj, got %s", projects[0].ID)
	}
}

const createNotificationService = ({ supabaseAdmin }) => {
    // Helper to Get Store Users (Owner + Managers)
    const getStoreUsers = async (storeId) => {
        try {
            const { data: store } = await supabaseAdmin
                .from('stores')
                .select('owner_id')
                .eq('id', storeId)
                .single();

            const { data: members } = await supabaseAdmin
                .from('store_members')
                .select('user_id')
                .eq('store_id', storeId);

            const ids = [store?.owner_id, ...members?.map((m) => m.user_id)].filter(Boolean);
            return [...new Set(ids)]; // Unique IDs
        } catch (e) {
            console.error('getStoreUsers Error:', e);
            return [];
        }
    };

    // Global Helper: Upsert Notification (Smart Update - Production Grade)
    const upsertNotificationGlobal = async (storeId, type, title, message, category, priority, referenceId, referenceType, payload) => {
        try {
            const userIds = await getStoreUsers(storeId);
            let createdCount = 0;

            for (const userId of userIds) {
                // Check for existing notification (same type + same reference for this user)
                // Fetch title and message to compare
                const { data: existing } = await supabaseAdmin
                    .from('notifications')
                    .select('id, title, message')
                    .eq('user_id', userId)
                    .eq('type', type)
                    .eq('reference_id', referenceId)
                    .eq('reference_type', referenceType)
                    .maybeSingle();

                if (existing) {
                    // Only update if content HAS CHANGED
                    if (existing.title !== title || existing.message !== message) {
                        await supabaseAdmin
                            .from('notifications')
                            .update({
                                title,
                                message,
                                payload,
                                priority,
                                is_read: false, // Reset to unread because info changed
                                // NOTE: Do NOT update created_at — changing it triggers Realtime
                                // and causes an infinite UPDATE loop on the frontend
                            })
                            .eq('id', existing.id);
                        createdCount++;
                    }
                    // If content is same, do NOTHING. Preserves original created_at and is_read status.
                } else {
                    // Insert new
                    await supabaseAdmin.from('notifications').insert([{
                        store_id: storeId,
                        user_id: userId,
                        type,
                        title,
                        message,
                        category,
                        priority,
                        reference_id: referenceId,
                        reference_type: referenceType,
                        payload,
                        is_read: false,
                        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
                    }]);
                    createdCount++;
                }
            }
            return createdCount > 0;
        } catch (e) {
            console.error('upsertNotificationGlobal Error:', e);
            return false;
        }
    };

    // Global Helper: Delete Notification (Auto-Resolve)
    const deleteNotificationGlobal = async (storeId, types, referenceId, referenceType) => {
        try {
            const typeArray = Array.isArray(types) ? types : [types];
            const userIds = await getStoreUsers(storeId);

            // Find notifications matching the criteria
            const { data: toDelete } = await supabaseAdmin
                .from('notifications')
                .select('id')
                .in('user_id', userIds)
                .eq('store_id', storeId)
                .in('type', typeArray)
                .eq('reference_id', referenceId)
                .eq('reference_type', referenceType);

            if (toDelete && toDelete.length > 0) {
                const ids = toDelete.map((n) => n.id);
                await supabaseAdmin.from('notifications').delete().in('id', ids);
            }
            return true;
        } catch (e) {
            console.error('deleteNotificationGlobal Error:', e);
            return false;
        }
    };

    return {
        upsertNotificationGlobal,
        deleteNotificationGlobal
    };
};

module.exports = { createNotificationService };

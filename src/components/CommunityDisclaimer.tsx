import React, { FC } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@patternfly/react-core';
import './CommunityDisclaimer.css';

const CommunityDisclaimer: FC = () => {
  const { t } = useTranslation('plugin__oct-odf-macvlans');

  return (
    <Alert
      className="ct-community-disclaimer"
      variant="info"
      isInline
      title={t('Community project. Not officially supported by Red Hat.')}
    >
      {t('OpenShift Community Tools is unofficial UX enhancements for the OpenShift Console.')}
    </Alert>
  );
};

export default CommunityDisclaimer;
